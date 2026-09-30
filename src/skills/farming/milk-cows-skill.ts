import type { AnimalInteraction } from '../../core/animal-interaction.port.js'
import type { AnimalScanner } from '../../core/animal-scanner.port.js'
import { countItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import type { FarmRegistry } from '../../state/farm-registry.js'
import { productSkip, tally, type Skipped } from './animal-products.js'
import { insideBounds, type Bounds } from './farm-area.types.js'
import type { PenGateGuard } from './pen-gate-guard.js'

const SEARCH_RADIUS = 32
const APPROACH_RANGE = 2.5
/** How long to wait for the inventory to show the milk after the click. */
const CONFIRM_MS = 2_000
const CONFIRM_POLL_MS = 250

export interface MilkCowsInput {
  readonly farm: string | undefined
  readonly area: Bounds | undefined
  /** How many buckets of milk are wanted. */
  readonly count: number
  /** Without a farm or an area: how far from the bot to look. */
  readonly maxDistance: number
}

export interface MilkCowsOutput {
  readonly buckets: number
  readonly requested: number
  /** How many cows were milked: each one once per call, so this is at most the number of cows in reach. */
  readonly cows: number
  readonly skipped: Skipped
  /** Set when the pen's gate could not be shut at the end. */
  readonly gateLeftOpen?: string
}

export interface MilkCowsDeps {
  readonly animals: AnimalScanner
  readonly interaction: AnimalInteraction
  readonly navigator: Navigator
  readonly inventory: InventoryReader
  readonly farms: FarmRegistry
  readonly scheduler: Scheduler
  readonly gates?: PenGateGuard
}

const carried = (inventory: InventoryReader, item: string): number =>
  countItems(inventory.snapshot()).get(item) ?? 0

/**
 * Fills empty buckets with milk: walks up to an adult cow (a mooshroom counts), uses a bucket on it, and checks that
 * the inventory gained a milk bucket. Each cow is milked once per call, so one cow is never milked in a loop; when
 * there are fewer cows than buckets wanted, the result is short of `requested`. Never crafts a bucket.
 */
export class MilkCowsSkill implements Skill<MilkCowsInput, MilkCowsOutput> {
  readonly name = 'milk_cows'

  constructor(private readonly deps: MilkCowsDeps) {}

  async run(input: MilkCowsInput, context: SkillContext): Promise<SkillResult<MilkCowsOutput>> {
    const bounds = this.resolveArea(input)
    const result = await this.work(input, bounds, context)
    return this.deps.gates?.finish(bounds, result, context.signal) ?? result
  }

  private async work(
    input: MilkCowsInput,
    bounds: Bounds | undefined,
    context: SkillContext,
  ): Promise<SkillResult<MilkCowsOutput>> {
    const { deps } = this
    if (input.farm !== undefined && bounds === undefined)
      return err({
        reason: 'unknown_farm',
        message: `No farm or pen is registered as ${input.farm}.`,
      })
    if (carried(deps.inventory, 'bucket') === 0)
      return err({
        reason: 'no_bucket',
        message:
          'The bot has no empty bucket. A bucket is made of 3 iron ingots: craft one first if the player agrees.',
      })
    const cows = deps.animals
      .nearby(SEARCH_RADIUS)
      .filter(
        (animal) =>
          (animal.species === 'cow' || animal.species === 'mooshroom') &&
          (bounds === undefined
            ? animal.distance <= input.maxDistance
            : insideBounds(animal.position, bounds)),
      )
    if (cows.length === 0)
      return err({
        reason: 'no_cows',
        message:
          bounds === undefined
            ? `No cows within ${String(input.maxDistance)} blocks.`
            : 'No cows in that pen or area.',
      })

    const skipped: Skipped = {}
    let buckets = 0
    for (const cow of cows) {
      if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
      if (buckets >= input.count) break
      if (carried(deps.inventory, 'bucket') === 0) break
      const reason = productSkip(cow)
      if (reason !== undefined) {
        tally(skipped, reason)
        continue
      }
      const before = carried(deps.inventory, 'milk_bucket')
      const held = await deps.interaction.hold('bucket')
      if (!held.ok) break
      const now = deps.animals.find(cow.id)
      if (now === undefined) {
        tally(skipped, 'unreachable')
        continue
      }
      const walked = await deps.navigator.goToPosition(now.position, APPROACH_RANGE, {
        signal: context.signal,
      })
      if (!walked.ok) {
        if (walked.error.reason === 'aborted')
          return err({ reason: 'aborted', message: 'Cancelled.' })
        tally(skipped, 'unreachable')
        continue
      }
      const used = await deps.interaction.use(cow.id)
      const got = used.ok && (await this.gained(before, context))
      if (!got) {
        tally(skipped, 'no_effect')
        continue
      }
      buckets += 1
      context.progress(`Milked ${String(buckets)} of ${String(input.count)} buckets`)
    }
    return ok({ buckets, requested: input.count, cows: buckets, skipped })
  }

  /** Waits a moment for the milk bucket to show in the inventory. */
  private async gained(before: number, context: SkillContext): Promise<boolean> {
    for (let waited = 0; waited < CONFIRM_MS; waited += CONFIRM_POLL_MS) {
      if (carried(this.deps.inventory, 'milk_bucket') > before) return true
      await sleep(this.deps.scheduler, CONFIRM_POLL_MS, context.signal)
      if (context.signal.aborted) return false
    }
    return carried(this.deps.inventory, 'milk_bucket') > before
  }

  private resolveArea(input: MilkCowsInput): Bounds | undefined {
    if (input.area !== undefined) return input.area
    if (input.farm === undefined) return undefined
    return this.deps.farms.resolve(input.farm)?.bounds
  }
}
