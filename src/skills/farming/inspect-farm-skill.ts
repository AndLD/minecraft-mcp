import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { CropAccess } from '../../core/crop.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { FarmEntry, FarmRegistry } from '../../state/farm-registry.js'
import { classifyCrop } from './crop-table.js'

export interface InspectFarmInput {
  readonly farm: string
}

export interface ComponentReport {
  readonly id: string
  readonly kind: FarmEntry['kind']
  readonly crop: string | null
  readonly ripe: number
  readonly growing: number
  readonly empty: number
}

export interface InspectFarmOutput {
  readonly components: readonly ComponentReport[]
}

export interface InspectFarmDeps {
  readonly blocks: BlockScanner
  readonly crops: CropAccess
  readonly farms: FarmRegistry
}

/** Read-only: reports each field's ripe, growing, and empty plots without touching anything. */
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
    if (entry.kind !== 'field')
      return { id: entry.id, kind: entry.kind, crop: entry.crop, ripe: 0, growing: 0, empty: 0 }
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
    return { id: entry.id, kind: entry.kind, crop: entry.crop, ripe, growing, empty }
  }
}
