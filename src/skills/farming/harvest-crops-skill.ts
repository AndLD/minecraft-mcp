import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { CropAccess } from '../../core/crop.port.js'
import type { Digger } from '../../core/digger.port.js'
import { countItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Placer } from '../../core/placer.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { FarmRegistry } from '../../state/farm-registry.js'
import type { DropCollector } from '../gathering/drop-collector.js'
import { classifyCrop, cropFor } from './crop-table.js'
import type { Bounds } from './farm-area.types.js'

const APPROACH_RANGE = 3
/** Keep at least this many seeds back for the next round before replanting spends the surplus. */
const SEED_RESERVE = 1

export interface HarvestCropsInput {
  readonly farm: string | undefined
  readonly area: Bounds | undefined
  readonly replant: boolean
}

export interface HarvestCropsOutput {
  readonly harvested: number
  readonly replanted: number
}

export interface HarvestCropsDeps {
  readonly blocks: BlockScanner
  readonly crops: CropAccess
  readonly navigator: Navigator
  readonly digger: Digger
  readonly placer: Placer
  readonly drops: DropCollector
  readonly inventory: InventoryReader
  readonly farms: FarmRegistry
}

/** Harvests only fully grown crops on a farm or an area and, by default, replants at once, keeping a seed reserve. */
export class HarvestCropsSkill implements Skill<HarvestCropsInput, HarvestCropsOutput> {
  readonly name = 'harvest_crops'

  constructor(private readonly deps: HarvestCropsDeps) {}

  async run(
    input: HarvestCropsInput,
    context: SkillContext,
  ): Promise<SkillResult<HarvestCropsOutput>> {
    const area = this.resolveArea(input)
    if (area === undefined) return err({ reason: 'no_area', message: 'Give a farm or an area to harvest.' })

    let harvested = 0
    let replanted = 0
    const y = area.from.y + 1 // crops sit one block above the farmland
    for (let x = area.from.x; x <= area.to.x; x += 1) {
      for (let z = area.from.z; z <= area.to.z; z += 1) {
        if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
        const at = { x, y, z }
        const state = this.deps.crops.stateAt(at)
        if (state === undefined) continue
        const spec = classifyCrop(state.name)
        if (spec === undefined || state.age < spec.maxAge) continue

        const walked = await this.deps.navigator.goToPosition(at, APPROACH_RANGE, {
          signal: context.signal,
        })
        if (!walked.ok) {
          if (walked.error.reason === 'aborted') return err({ reason: 'aborted', message: 'Cancelled.' })
          continue
        }
        const dug = await this.deps.digger.dig(at, context.signal)
        if (!dug.ok) {
          if (dug.error.reason === 'aborted') return err({ reason: 'aborted', message: 'Cancelled.' })
          continue
        }
        harvested += 1
        await this.deps.drops.collectNear(at, context.signal)
        context.progress(`Harvested ${String(harvested)} ${state.name}`)

        if (input.replant) {
          const cropInfo = cropFor(state.name)
          if (cropInfo !== undefined) {
            const carried = countItems(this.deps.inventory.snapshot()).get(cropInfo.spec.seed) ?? 0
            if (carried > SEED_RESERVE) {
              const placed = await this.deps.placer.placeAt(cropInfo.spec.seed, at)
              if (placed.ok) replanted += 1
            }
          }
        }
      }
    }
    return ok({ harvested, replanted })
  }

  private resolveArea(input: HarvestCropsInput): Bounds | undefined {
    if (input.area !== undefined) return input.area
    if (input.farm === undefined) return undefined
    return this.deps.farms.resolve(input.farm)?.bounds
  }
}
