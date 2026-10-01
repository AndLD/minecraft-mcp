import type { AreaGuard } from '../../core/area-guard.port.js'
import type { BlockUser } from '../../core/block-user.port.js'
import type { CropAccess } from '../../core/crop.port.js'
import { countItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { FarmRegistry } from '../../state/farm-registry.js'
import type { BoneMealSources, BoneMealSupplier } from './bone-meal-supply.js'
import { classifyCrop, cropNameOfBlock } from './crop-table.js'
import type { Bounds } from './farm-area.types.js'

const BONE_MEAL = 'bone_meal'
const APPROACH_RANGE = 3
/** A use can fail in the game (a bone meal may be spent without a new stage); this many tries per plant per pass. */
const MAX_USES_PER_PLANT = 8
const PASSES = 2
/** The server answers a use within a tick or two; read the crop again after this long. */
const SETTLE_MS = 250

export interface FertilizeCropsInput {
  readonly farm: string | undefined
  readonly area: Bounds | undefined
  /** Only this crop (`wheat`, `carrots`, `pumpkin`, ...). */
  readonly crop: string | undefined
  /** Grow each plant this many stages at most; until ripe when undefined. */
  readonly stages: number | undefined
  /** Use at most this much bone meal; everything carried when undefined. */
  readonly maxBoneMeal: number | undefined
  readonly sources: BoneMealSources
}

export interface FertilizeCropsOutput {
  /** Bone meal used. */
  readonly applied: number
  /** Plants that reached ripe. */
  readonly ripened: number
  readonly skipped: {
    readonly protected: number
    readonly unreachable: number
    readonly alreadyRipe: number
  }
  readonly boneMealLeft: number
}

export interface FertilizeCropsDeps {
  readonly crops: CropAccess
  readonly navigator: Navigator
  readonly user: BlockUser
  readonly inventory: InventoryReader
  readonly farms: FarmRegistry
  readonly guard: AreaGuard
  readonly vitals: VitalsReader
  readonly scheduler: Scheduler
  readonly supply: BoneMealSupplier
}

interface Plot {
  readonly at: Position
  readonly ownLabel: string | null
}

const carried = (inventory: InventoryReader): number =>
  countItems(inventory.snapshot()).get(BONE_MEAL) ?? 0

/**
 * Uses bone meal on the unripe crops of a field, nearest first, reading each crop's age after every use and stopping
 * at ripe (or after `stages`). It never runs by itself: a player asked for it. Stem crops grow only their stem (the
 * fruit is not touched), a crop that is ripe already is left alone, and a protected cell that is not the field's own
 * is skipped.
 */
export class FertilizeCropsSkill implements Skill<FertilizeCropsInput, FertilizeCropsOutput> {
  readonly name = 'fertilize_crops'

  constructor(private readonly deps: FertilizeCropsDeps) {}

  async run(
    input: FertilizeCropsInput,
    context: SkillContext,
  ): Promise<SkillResult<FertilizeCropsOutput>> {
    const { deps } = this
    const fields = this.resolveFields(input)
    if (fields === undefined)
      return err({
        reason: 'no_area',
        message:
          input.farm === undefined
            ? 'Give a farm or an area to fertilize.'
            : `There is no farm or group "${input.farm}". See list_farms.`,
      })

    const skipped = { protected: 0, unreachable: 0, alreadyRipe: 0 }
    const plots = this.unripe(fields, input, skipped)
    const start = carried(deps.inventory)
    const cap = input.maxBoneMeal ?? Number.POSITIVE_INFINITY
    if (plots.size === 0) return ok({ applied: 0, ripened: 0, skipped, boneMealLeft: start })

    const wanted = Math.min(cap, plots.size)
    if (start < wanted) {
      context.progress('Getting bone meal')
      await deps.supply.ensure(wanted, input.sources, context)
    }
    if (carried(deps.inventory) === 0)
      return err({
        reason: 'missing_bone_meal',
        message: `The bot has no bone meal and ${String(plots.size)} crops are unripe. One bone crafts 3 bone meal; it needs about ${String(wanted)}. Give some, or allow storage or crafting.`,
        detail: { unripe: plots.size },
      })

    let applied = 0
    const ripened = new Set<string>()
    /** Plants that reached what was asked (ripe, or the stage limit): not worked on again in the next pass. */
    const done = new Set<string>()
    const left = (): number => Math.min(carried(deps.inventory), cap - applied)
    for (let pass = 0; pass < PASSES && plots.size > done.size; pass += 1) {
      for (const plot of this.nearestFirst([...plots.values()])) {
        if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
        const key = `${String(plot.at.x)},${String(plot.at.y)},${String(plot.at.z)}`
        if (done.has(key)) continue
        if (left() <= 0) break
        const outcome = await this.fertilizeOne(plot, input.stages, left(), context)
        applied += outcome.used
        if (outcome.result === 'ripe') ripened.add(key)
        if (outcome.result === 'ripe' || outcome.result === 'target') done.add(key)
        else if (outcome.result === 'unreachable' && pass === PASSES - 1) skipped.unreachable += 1
        context.progress(`Used ${String(applied)} bone meal, ${String(ripened.size)} plants ripe`)
      }
      if (left() <= 0) break
    }
    return ok({ applied, ripened: ripened.size, skipped, boneMealLeft: carried(deps.inventory) })
  }

  /** One plant: walks up and uses bone meal until it is ripe (or the stage target, the budget, or the tries run out). */
  private async fertilizeOne(
    plot: Plot,
    stages: number | undefined,
    budget: number,
    context: SkillContext,
  ): Promise<{ used: number; result: 'ripe' | 'target' | 'grown' | 'unreachable' }> {
    const { deps } = this
    const walked = await deps.navigator.goToPosition(plot.at, APPROACH_RANGE, {
      signal: context.signal,
    })
    if (!walked.ok) return { used: 0, result: 'unreachable' }
    const first = deps.crops.stateAt(plot.at)
    const spec = first === undefined ? undefined : classifyCrop(first.name)
    if (first === undefined || spec === undefined) return { used: 0, result: 'grown' }
    const target = stages === undefined ? spec.maxAge : Math.min(spec.maxAge, first.age + stages)
    let used = 0
    for (let tries = 0; tries < MAX_USES_PER_PLANT; tries += 1) {
      if (context.signal.aborted || used >= budget || carried(deps.inventory) <= 0) break
      const before = carried(deps.inventory)
      const clicked = await deps.user.use(plot.at, BONE_MEAL)
      if (!clicked.ok) return { used, result: 'unreachable' }
      await sleep(deps.scheduler, SETTLE_MS, context.signal)
      used += Math.max(0, before - carried(deps.inventory))
      const now = deps.crops.stateAt(plot.at)
      if (now === undefined) return { used, result: 'grown' }
      if (now.age >= target) return { used, result: now.age >= spec.maxAge ? 'ripe' : 'target' }
    }
    return { used, result: 'grown' }
  }

  /** Every crop in the fields that is not ripe, left out when protected (unless it is the field's own area). */
  private unripe(
    fields: readonly { bounds: Bounds; label: string | null }[],
    input: FertilizeCropsInput,
    skipped: { protected: number; unreachable: number; alreadyRipe: number },
  ): Map<string, Plot> {
    const plots = new Map<string, Plot>()
    for (const field of fields) {
      const y = field.bounds.from.y + 1 // crops sit one block above the farmland
      for (let x = field.bounds.from.x; x <= field.bounds.to.x; x += 1) {
        for (let z = field.bounds.from.z; z <= field.bounds.to.z; z += 1) {
          const at = { x, y, z }
          const state = this.deps.crops.stateAt(at)
          if (state === undefined) continue
          const spec = classifyCrop(state.name)
          if (spec === undefined) continue
          if (input.crop !== undefined && cropNameOfBlock(state.name) !== input.crop) continue
          if (state.age >= spec.maxAge) {
            skipped.alreadyRipe += 1
            continue
          }
          const guarded = this.deps.guard.protectedAt(at)
          if (guarded !== undefined && guarded.label !== field.label) {
            skipped.protected += 1
            continue
          }
          plots.set(`${String(x)},${String(y)},${String(z)}`, { at, ownLabel: field.label })
        }
      }
    }
    return plots
  }

  private nearestFirst(plots: Plot[]): Plot[] {
    const here = this.deps.vitals.read()?.position
    if (here === undefined) return plots
    return [...plots].sort((a, b) => distanceBetween(here, a.at) - distanceBetween(here, b.at))
  }

  private resolveFields(
    input: FertilizeCropsInput,
  ): { bounds: Bounds; label: string | null }[] | undefined {
    if (input.area !== undefined) return [{ bounds: input.area, label: null }]
    if (input.farm === undefined) return undefined
    const single = this.deps.farms.resolve(input.farm)
    const entries = single !== undefined ? [single] : this.deps.farms.byGroup(input.farm)
    const fields = entries.filter((entry) => entry.kind === 'field')
    return fields.length === 0
      ? undefined
      : fields.map((f) => ({ bounds: f.bounds, label: f.label }))
  }
}
