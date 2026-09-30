import type { Position } from '../../core/position.types.js'
import { err, ok, type Result } from '../../core/result.js'
import { isStructureKind } from '../../core/structure-kinds.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { WorldKnowledgeStore } from '../../knowledge/world-knowledge-store.js'
import type { ContainerIndex } from '../../state/container-index.js'
import type { FarmRegistry } from '../../state/farm-registry.js'
import { normalizeName } from '../discovery/name-match.js'

export interface LeadTarget {
  /** What the bot calls it in chat: "home", "the village". */
  readonly label: string
  readonly position: Position
  /** Where the name came from; structures and biomes exist only in the Overworld. */
  readonly source: 'landmark' | 'container' | 'farm' | 'structure' | 'biome' | 'position'
}

export interface LeadTargetDeps {
  readonly knowledge: WorldKnowledgeStore
  readonly containers: ContainerIndex
  readonly farms: FarmRegistry
  readonly vitals: VitalsReader
}

/** Turns "home", "the village", a chest label, or a farm name into a place. */
export class LeadTargetResolver {
  constructor(private readonly deps: LeadTargetDeps) {}

  resolve(text: string): Result<LeadTarget> {
    const { knowledge, containers, farms, vitals } = this.deps
    const wanted = text.trim().replace(/^the\s+/i, '')

    const landmark = knowledge.landmark(wanted)
    if (landmark !== undefined)
      return ok({ label: landmark.name, position: landmark, source: 'landmark' })

    const container = containers.resolve(wanted)
    if (container !== undefined)
      return ok({
        label: container.label ?? container.id,
        position: container.position,
        source: 'container',
      })

    const farm = farms.resolve(wanted)
    if (farm !== undefined) {
      const { from, to } = farm.bounds
      return ok({
        label: farm.label ?? farm.id,
        position: {
          x: Math.round((from.x + to.x) / 2),
          y: Math.min(from.y, to.y),
          z: Math.round((from.z + to.z) / 2),
        },
        source: 'farm',
      })
    }

    const here = vitals.read()?.position ?? { x: 0, y: 0, z: 0 }
    const name = normalizeName(wanted)
    if (isStructureKind(name)) {
      const structure = knowledge.nearest(name, here)
      if (structure !== undefined)
        return ok({
          label: `the ${name.replace(/_/g, ' ')}`,
          position: structure,
          source: 'structure',
        })
      return err(
        `No ${name.replace(/_/g, ' ')} is known yet. Find one first (explore_for_structure), then lead there.`,
      )
    }
    const biome = knowledge.nearestBiome([name], here)
    if (biome !== undefined)
      return ok({ label: `the ${name.replace(/_/g, ' ')} biome`, position: biome, source: 'biome' })

    const known = [
      ...knowledge.landmarks().map((entry) => entry.name),
      ...containers.all().flatMap((entry) => (entry.label === null ? [] : [entry.label])),
      ...farms.all().flatMap((entry) => (entry.label === null ? [] : [entry.label])),
    ]
    return err(
      `Nothing called "${text}" is known${known.length === 0 ? '' : ` (known places: ${known.join(', ')})`}. Give a landmark, a known structure, or x, y, z.`,
    )
  }
}
