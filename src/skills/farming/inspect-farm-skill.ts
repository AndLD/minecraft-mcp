import type { AnimalScanner } from '../../core/animal-scanner.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { CropAccess } from '../../core/crop.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { FarmEntry, FarmRegistry } from '../../state/farm-registry.js'
import { classifyCrop } from './crop-table.js'
import { insideBounds } from './farm-area.types.js'
import { scanGrove } from './grove-scan.js'

const SEARCH_RADIUS = 48

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

  private reportOn(entry: FarmEntry): ComponentReport {
    const base = {
      id: entry.id,
      kind: entry.kind,
      crop: entry.crop,
      species: entry.species,
      herdTarget: entry.herdTarget,
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
