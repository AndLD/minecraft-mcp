import type { AnimalScanner } from '../../core/animal-scanner.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { CropAccess } from '../../core/crop.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { FarmEntry, FarmRegistry } from '../../state/farm-registry.js'
import { classifyCrop, cropFor, stemCropOfFruit } from './crop-table.js'
import { insideBounds } from './farm-area.types.js'
import { scanGrove } from './grove-scan.js'

const SEARCH_RADIUS = 48
const isFencePart = (name: string): boolean =>
  name.endsWith('_fence') || name.endsWith('_fence_gate') || name === 'torch' || name === 'water'

export interface InspectFarmInput {
  readonly farm: string
}

export interface ComponentReport {
  readonly id: string
  readonly kind: FarmEntry['kind']
  readonly crop: string | null
  /** Field: ripe, growing, and empty plots. Grove: grown trees, saplings, and empty spots (`crop` is the tree). */
  readonly ripe: number
  readonly growing: number
  readonly empty: number
  /**
   * Pumpkin field: free cells (beside the stems) with something other than air or a pumpkin on them, so a stem cannot
   * grow its fruit there. Ripe is then the pumpkins waiting, growing the stems, empty the stem plots with no stem.
   */
  readonly blocked: number
  /** The side of the fence the gate is on, when known. */
  readonly gateSide: FarmEntry['gateSide']
  /** Pen: the species it keeps, adult and baby counts, and the target herd size. */
  readonly species: string | null
  readonly adults: number
  readonly babies: number
  readonly herdTarget: number | null
}

export interface InspectFarmOutput {
  readonly components: readonly ComponentReport[]
}

export interface InspectFarmDeps {
  readonly blocks: BlockScanner
  readonly crops: CropAccess
  readonly animals: AnimalScanner
  readonly farms: FarmRegistry
}

/** Read-only: reports each field's ripe/growing/empty plots and each pen's herd, without touching anything. */
export class InspectFarmSkill implements Skill<InspectFarmInput, InspectFarmOutput> {
  readonly name = 'inspect_farm'

  constructor(private readonly deps: InspectFarmDeps) {}

  run(input: InspectFarmInput, _context: SkillContext): Promise<SkillResult<InspectFarmOutput>> {
    const single = this.deps.farms.resolve(input.farm)
    const entries = single !== undefined ? [single] : this.deps.farms.byGroup(input.farm)
    if (entries.length === 0)
      return Promise.resolve(
        err({
          reason: 'unknown_farm',
          message: `There is no farm or group "${input.farm}". See list_farms.`,
        }),
      )
    return Promise.resolve(ok({ components: entries.map((entry) => this.reportOn(entry)) }))
  }

  /**
   * A stem field: farmland cells are stem plots (a stem, or empty); a pumpkin is ripe wherever one stands above the
   * ground; a cell above plain ground that holds anything else is blocked (the fruit has nowhere to grow beside it).
   */
  private reportOnStemField(
    entry: FarmEntry,
    base: Omit<ComponentReport, 'ripe' | 'growing' | 'empty' | 'blocked' | 'adults' | 'babies'>,
  ): ComponentReport {
    let ripe = 0
    let growing = 0
    let empty = 0
    let blocked = 0
    const groundY = entry.bounds.from.y
    const cropY = groundY + 1
    for (let x = entry.bounds.from.x; x <= entry.bounds.to.x; x += 1) {
      for (let z = entry.bounds.from.z; z <= entry.bounds.to.z; z += 1) {
        const ground = this.deps.blocks.blockAt({ x, y: groundY, z })
        const above = this.deps.blocks.blockAt({ x, y: cropY, z })
        if (above === undefined) continue
        if (stemCropOfFruit(above) !== undefined) ripe += 1
        else if (classifyCrop(above)?.kind === 'stem') growing += 1
        else if (ground === 'farmland') empty += 1
        else if (
          above !== 'air' &&
          (ground === 'dirt' || ground === 'grass_block') &&
          !isFencePart(above)
        )
          blocked += 1
      }
    }
    return { ...base, ripe, growing, empty, blocked, adults: 0, babies: 0 }
  }

  private reportOn(entry: FarmEntry): ComponentReport {
    const base = {
      id: entry.id,
      kind: entry.kind,
      crop: entry.crop,
      species: entry.species,
      herdTarget: entry.herdTarget,
      gateSide: entry.gateSide,
      blocked: 0,
    }
    if (entry.kind === 'pen') {
      const herd = this.deps.animals
        .nearby(SEARCH_RADIUS)
        .filter((a) => a.species === entry.species && insideBounds(a.position, entry.bounds))
      return {
        ...base,
        ripe: 0,
        growing: 0,
        empty: 0,
        adults: herd.filter((a) => !a.baby).length,
        babies: herd.filter((a) => a.baby).length,
      }
    }
    if (entry.kind === 'grove') {
      const sites = scanGrove(entry, this.deps.blocks)
      return {
        ...base,
        ripe: sites.filter((site) => site.state === 'grown').length,
        growing: sites.filter((site) => site.state === 'sapling').length,
        empty: sites.filter((site) => site.state === 'empty').length,
        adults: 0,
        babies: 0,
      }
    }

    const stemCrop = entry.crop === null ? undefined : cropFor(entry.crop)?.spec
    if (stemCrop?.kind === 'stem') return this.reportOnStemField(entry, base)
    let ripe = 0
    let growing = 0
    let empty = 0
    const groundY = entry.bounds.from.y
    const cropY = groundY + 1
    for (let x = entry.bounds.from.x; x <= entry.bounds.to.x; x += 1) {
      for (let z = entry.bounds.from.z; z <= entry.bounds.to.z; z += 1) {
        if (this.deps.blocks.blockAt({ x, y: groundY, z }) !== 'farmland') continue
        const state = this.deps.crops.stateAt({ x, y: cropY, z })
        const spec = state === undefined ? undefined : classifyCrop(state.name)
        if (spec === undefined || state === undefined) empty += 1
        else if (state.age >= spec.maxAge) ripe += 1
        else growing += 1
      }
    }
    return { ...base, ripe, growing, empty, adults: 0, babies: 0 }
  }
}
