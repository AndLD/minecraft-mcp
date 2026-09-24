import type { AnimalScanner } from '../../core/animal-scanner.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { CropAccess } from '../../core/crop.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { FarmRegistry } from '../../state/farm-registry.js'
import { isPenBarrier } from '../hunting/pen-detector.js'
import { PENNABLE_SPECIES } from './animal-table.js'
import { classifyCrop } from './crop-table.js'
import {
  boundsOfCells,
  clusterCells,
  findEnclosures,
  type Cell,
  type Region,
} from './discover-shapes.js'
import { insideBounds, type Bounds } from './farm-area.types.js'

const DEFAULT_RADIUS = 24
/** Farmland cells within this many blocks of each other are one field (bridges a one-block water channel). */
const FIELD_GAP = 2
const MIN_PLOTS = 4
const MAX_FOUND = 3000
/** A fenced area bigger than this on a side is not taken for a pen. */
const MAX_PEN_SIDE = 62
const MIN_FILL = 0.8
const MAX_PROPOSALS = 20

export interface DiscoverFarmInput {
  /** The place to look around; the bot's own position when left out. */
  readonly around: Position | undefined
  readonly radius: number | undefined
  /** A group name to put in every proposed registration, for example `home`. */
  readonly group: string | undefined
}

/** The arguments to hand to `register_farm` to accept a proposal, as they are. */
export interface ProposedRegistration {
  readonly kind: 'field' | 'pen'
  readonly from: Position
  readonly to: Position
  readonly crop?: string
  readonly species?: string
  readonly herd_target?: number
  readonly label: string
  readonly group?: string
}

export interface FarmProposal {
  readonly kind: 'field' | 'pen'
  /** `high` when there are crops or animals to go by, `low` when the shape is all there is. */
  readonly confidence: 'high' | 'low'
  readonly bounds: Bounds
  /** Field: farmland plots, and the crops standing on them by name. */
  readonly plots?: number
  readonly crops?: Readonly<Record<string, number>>
  /** Pen: the pennable animals inside by species, and whether the fence has a gate. */
  readonly animals?: Readonly<Record<string, number>>
  readonly hasGate?: boolean
  readonly notes: readonly string[]
  readonly register: ProposedRegistration
}

export interface KnownComponent {
  readonly id: string
  readonly label: string | null
  readonly kind: string
}

export interface DiscoverFarmOutput {
  readonly center: Position
  readonly radius: number
  readonly proposals: readonly FarmProposal[]
  /** Things found that a registered farm already covers. */
  readonly alreadyRegistered: readonly KnownComponent[]
  /** More was found than is listed. */
  readonly truncated: boolean
}

export interface DiscoverFarmDeps {
  readonly blocks: BlockScanner
  readonly crops: CropAccess
  readonly animals: AnimalScanner
  readonly farms: FarmRegistry
  readonly vitals: VitalsReader
}

const cellsOverlap = (a: Bounds, b: Bounds): boolean =>
  a.from.x <= b.to.x && a.to.x >= b.from.x && a.from.z <= b.to.z && a.to.z >= b.from.z

const mostCommon = (counts: Readonly<Record<string, number>>): string | undefined =>
  Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]

/**
 * Looks around a place for farms nobody told the bot about, and **proposes** how to register them: fields from
 * clusters of farmland (the crop from what grows on it), pens from fenced areas (the species from the animals
 * inside). Read-only, and it registers nothing: the agent shows the proposals to the player and calls `register_farm`
 * with a proposal's `register` arguments once they agree. Anything a registered farm already covers is left out.
 * Not covered: groves (a forest is not a farm until somebody says so), and fences on a slope or with a gap.
 */
export class DiscoverFarmSkill implements Skill<DiscoverFarmInput, DiscoverFarmOutput> {
  readonly name = 'discover_farm'

  constructor(private readonly deps: DiscoverFarmDeps) {}

  run(input: DiscoverFarmInput, _context: SkillContext): Promise<SkillResult<DiscoverFarmOutput>> {
    const here = this.deps.vitals.read()?.position
    if (here === undefined)
      return Promise.resolve(
        err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' }),
      )
    const center = input.around ?? here
    const radius = input.radius ?? DEFAULT_RADIUS
    // The scanner searches around the bot, so reach as far as the place asked about plus the radius.
    const reach = distanceBetween(here, center) + radius
    const near = (x: number, z: number): boolean =>
      Math.abs(x - center.x) <= radius && Math.abs(z - center.z) <= radius

    const found = [...this.fields(reach, near), ...this.pens(reach, near)]
    const known = this.deps.farms.all()
    const proposals: FarmProposal[] = []
    const covered = new Map<string, KnownComponent>()
    for (const candidate of found) {
      const registered = known.find((farm) => cellsOverlap(farm.bounds, candidate.bounds))
      if (registered !== undefined) {
        covered.set(registered.id, {
          id: registered.id,
          label: registered.label,
          kind: registered.kind,
        })
        continue
      }
      proposals.push(candidate)
    }

    proposals.sort((a, b) => this.distanceTo(center, a.bounds) - this.distanceTo(center, b.bounds))
    const ordered: FarmProposal[] = []
    for (const proposal of proposals) ordered.push(this.named(proposal, ordered, input.group))
    return Promise.resolve(
      ok({
        center,
        radius,
        proposals: ordered.slice(0, MAX_PROPOSALS),
        alreadyRegistered: [...covered.values()],
        truncated: ordered.length > MAX_PROPOSALS,
      }),
    )
  }

  private distanceTo(center: Position, bounds: Bounds): number {
    return distanceBetween(center, {
      x: (bounds.from.x + bounds.to.x) / 2,
      y: center.y,
      z: (bounds.from.z + bounds.to.z) / 2,
    })
  }

  /** Clusters of farmland, and the crops that stand on them. */
  private fields(reach: number, near: (x: number, z: number) => boolean): FarmProposal[] {
    const farmland = this.deps.blocks
      .findBlocks({ names: ['farmland'], maxDistance: reach, count: MAX_FOUND })
      .filter((block) => near(block.position.x, block.position.z))
    const levels = new Map<number, Cell[]>()
    for (const block of farmland) {
      const level = levels.get(block.position.y) ?? []
      level.push({ x: block.position.x, z: block.position.z })
      levels.set(block.position.y, level)
    }

    const proposals: FarmProposal[] = []
    for (const [y, cells] of levels) {
      for (const cluster of clusterCells(cells, FIELD_GAP)) {
        if (cluster.length < MIN_PLOTS) continue
        const box = boundsOfCells(cluster)
        const crops: Record<string, number> = {}
        for (const cell of cluster) {
          const state = this.deps.crops.stateAt({ x: cell.x, y: y + 1, z: cell.z })
          if (state !== undefined && classifyCrop(state.name) !== undefined)
            crops[state.name] = (crops[state.name] ?? 0) + 1
        }
        const crop = mostCommon(crops)
        const notes = [
          'The bounds cover the farmland and any water between it, not a fence around it.',
          ...(crop === undefined
            ? ['Nothing is planted yet: give the crop when registering.']
            : []),
          ...(Object.keys(crops).length > 1
            ? [`Mixed crops (${describe(crops)}): proposed the most common.`]
            : []),
        ]
        const bounds = {
          from: { x: box.minX, y, z: box.minZ },
          to: { x: box.maxX, y: y + 1, z: box.maxZ },
        }
        proposals.push({
          kind: 'field',
          confidence: crop === undefined ? 'low' : 'high',
          bounds,
          plots: cluster.length,
          crops,
          notes,
          register: {
            kind: 'field',
            from: bounds.from,
            to: bounds.to,
            ...(crop === undefined ? {} : { crop }),
            label: '',
          },
        })
      }
    }
    return proposals
  }

  /** Fenced areas with pennable animals inside (or, less sure, an empty one with a gate). */
  private pens(reach: number, near: (x: number, z: number) => boolean): FarmProposal[] {
    const names = this.deps.blocks.knownBlockNames().filter(isPenBarrier)
    if (names.length === 0) return []
    const barriers = this.deps.blocks.findBlocks({ names, maxDistance: reach, count: MAX_FOUND })
    const levels = new Map<number, Map<string, string>>()
    for (const block of barriers) {
      const level = levels.get(block.position.y) ?? new Map<string, string>()
      level.set(`${String(block.position.x)},${String(block.position.z)}`, block.name)
      levels.set(block.position.y, level)
    }
    const animals = this.deps.animals
      .nearby(reach)
      .filter((animal) => !animal.dead && PENNABLE_SPECIES.includes(animal.species))

    const proposals: FarmProposal[] = []
    for (const [y, level] of levels) {
      const cells = [...level.keys()].map((key): Cell => {
        const [x = 0, z = 0] = key.split(',').map(Number)
        return { x, z }
      })
      for (const region of findEnclosures(cells)) {
        const width = region.maxX - region.minX + 1
        const length = region.maxZ - region.minZ + 1
        if (width < 2 || length < 2 || width > MAX_PEN_SIDE || length > MAX_PEN_SIDE) continue
        if (region.cells < MIN_FILL * width * length) continue
        if (!near((region.minX + region.maxX) / 2, (region.minZ + region.maxZ) / 2)) continue
        if (this.hasFarmland(region, y - 1)) continue

        const bounds = {
          from: { x: region.minX - 1, y: y - 1, z: region.minZ - 1 },
          to: { x: region.maxX + 1, y: y + 1, z: region.maxZ + 1 },
        }
        const counts: Record<string, number> = {}
        for (const animal of animals)
          if (insideBounds(animal.position, bounds))
            counts[animal.species] = (counts[animal.species] ?? 0) + 1
        const hasGate = [...level.entries()].some(
          ([key, name]) => name.endsWith('_fence_gate') && this.within(key, bounds),
        )
        const species = mostCommon(counts)
        if (species === undefined && !hasGate) continue

        const herd = species === undefined ? 0 : (counts[species] ?? 0)
        proposals.push({
          kind: 'pen',
          confidence: species === undefined ? 'low' : 'high',
          bounds,
          animals: counts,
          hasGate,
          notes: [
            'The bounds include the fence, like a pen built with build_farm.',
            ...(species === undefined
              ? ['Nothing is in it: give the species when registering, or skip it.']
              : [
                  `herd_target is the herd right now (${String(herd)}): tend_farm keeps it there, and breeds or culls once it is changed.`,
                ]),
            ...(Object.keys(counts).length > 1
              ? [`Mixed animals (${describe(counts)}): proposed the most common.`]
              : []),
          ],
          register: {
            kind: 'pen',
            from: bounds.from,
            to: bounds.to,
            ...(species === undefined ? {} : { species, herd_target: herd }),
            label: '',
          },
        })
      }
    }
    return proposals
  }

  private hasFarmland(region: Region, y: number): boolean {
    for (let x = region.minX; x <= region.maxX; x += 1)
      for (let z = region.minZ; z <= region.maxZ; z += 1)
        if (this.deps.blocks.blockAt({ x, y, z }) === 'farmland') return true
    return false
  }

  private within(key: string, bounds: Bounds): boolean {
    const [x = 0, z = 0] = key.split(',').map(Number)
    return x >= bounds.from.x && x <= bounds.to.x && z >= bounds.from.z && z <= bounds.to.z
  }

  /** Gives the proposal a label no farm or earlier proposal uses, and the group asked for. */
  private named(
    proposal: FarmProposal,
    before: readonly FarmProposal[],
    group: string | undefined,
  ): FarmProposal {
    const { crop, species } = proposal.register
    const base =
      proposal.kind === 'field'
        ? crop === undefined
          ? 'field'
          : `${crop} field`
        : `${species ?? 'animal'} pen`
    const used = new Set(before.map((other) => other.register.label.toLowerCase()))
    let label = base
    for (
      let n = 2;
      this.deps.farms.byLabel(label) !== undefined || used.has(label.toLowerCase());
      n += 1
    )
      label = `${base} ${String(n)}`
    return {
      ...proposal,
      register: { ...proposal.register, label, ...(group === undefined ? {} : { group }) },
    }
  }
}

function describe(counts: Readonly<Record<string, number>>): string {
  return Object.entries(counts)
    .map(([name, count]) => `${String(count)} ${name}`)
    .join(', ')
}
