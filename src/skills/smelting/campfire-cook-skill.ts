import type { AreaGuard } from '../../core/area-guard.port.js'
import type { CampfireAccess } from '../../core/campfire.port.js'
import type { Clock } from '../../core/clock.port.js'
import { countItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { SkillContext, SkillResult } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { DropCollector } from '../gathering/drop-collector.js'
import type { Workstations } from '../crafting/workstations.js'
import { CAMPFIRE_BLOCKS, CAMPFIRE_MS_PER_ITEM, CAMPFIRE_SLOTS } from './stations.js'

/** How close the bot stands to the fire: beside it, never on it. */
const FIRE_REACH = 2.5
/** Cooked food pops out a moment after its 30 seconds; the wait covers that. */
const POP_SLACK_MS = 1_500
const MIN_WAIT_MS = 1_000
const TIMEOUT_SLACK_MS = 60_000
/** Items that pop out land within a few blocks of the fire. */
const PICKUP_RADIUS = 6
/** A campfire that keeps refusing food (someone else's items on it) ends the job after this many refusals in a row. */
const MAX_REFUSALS = 3
const REFUSAL_WAIT_MS = 5_000

export interface CampfireCookInput {
  readonly item: string
  readonly produced: string
  /** How many to cook; everything carried when undefined. */
  readonly count: number | undefined
}

export interface CampfireCookOutput {
  readonly cooked: number
  readonly fire: Position
}

export interface CampfireCookDeps {
  readonly fires: CampfireAccess
  readonly workstations: Pick<Workstations, 'nearestOf'>
  readonly navigator: Navigator
  readonly inventory: InventoryReader
  readonly drops: Pick<DropCollector, 'collect'>
  readonly guard: AreaGuard
  readonly vitals: VitalsReader
  readonly scheduler: Scheduler
  readonly clock: Clock
}

/** What `SmeltItemsSkill` needs from the campfire: cook a batch of raw food and bring it back. */
export interface CampfireCooker {
  cook(input: CampfireCookInput, context: SkillContext): Promise<SkillResult<CampfireCookOutput>>
}

/**
 * Cooks raw food on a campfire: no window and no fuel. Up to four items go on the block, each cooks for 30 seconds
 * and pops out beside the fire as a dropped item, which the bot picks up before putting the next ones on. The bot
 * does not stand still: it waits on the scheduler (so a chat message or a new task can cut the wait short). Items that
 * are still on the fire when the job is cut short cannot be taken back (the game has no way to); they pop out by
 * themselves and the message says so.
 */
export class CampfireCookSkill implements CampfireCooker {
  constructor(private readonly deps: CampfireCookDeps) {}

  async cook(
    input: CampfireCookInput,
    context: SkillContext,
  ): Promise<SkillResult<CampfireCookOutput>> {
    const { deps } = this
    const fire = deps.workstations.nearestOf(CAMPFIRE_BLOCKS)
    if (fire === undefined)
      return err({
        reason: 'no_campfire',
        message:
          'There is no campfire nearby. A campfire is made from 3 sticks, 1 coal or charcoal, and 3 logs; it is not crafted on the way.',
      })
    const area = deps.guard.protectedAt(fire)
    if (area !== undefined)
      return err({
        reason: 'protected_area',
        message: `The campfire is inside the protected area ${area.label}: it is someone's build, so it is not used.`,
      })
    const state = deps.fires.stateAt(fire)
    if (state !== 'lit')
      return err({
        reason: state === 'out' ? 'campfire_out' : 'no_campfire',
        message:
          state === 'out'
            ? 'The campfire is out (water or rain put it out). It must be lit with flint and steel first.'
            : 'The block there is not a campfire any more.',
      })

    const counts = countItems(deps.inventory.snapshot())
    const have = counts.get(input.item) ?? 0
    const requested = input.count ?? have
    if (have === 0 || have < requested)
      return err({
        reason: 'missing_items',
        message: `Cannot cook ${String(requested)} ${input.item}: the bot has ${String(have)}.`,
      })

    const walked = await deps.navigator.goToPosition(fire, FIRE_REACH, { signal: context.signal })
    if (!walked.ok)
      return err({
        reason: walked.error.reason === 'aborted' ? 'aborted' : 'unreachable',
        message: `Could not get to the campfire: ${walked.error.message}`,
      })
    await this.stepOff(fire, context)

    return this.loop(input, fire, requested, counts.get(input.produced) ?? 0, context)
  }

  private async loop(
    input: CampfireCookInput,
    fire: Position,
    requested: number,
    producedBefore: number,
    context: SkillContext,
  ): Promise<SkillResult<CampfireCookOutput>> {
    const { deps } = this
    const { clock, scheduler } = deps
    /** When each item on the fire was put there. */
    let onFire: number[] = []
    let put = 0
    let refusals = 0
    const deadline =
      clock.now() +
      Math.ceil(requested / CAMPFIRE_SLOTS) * (CAMPFIRE_MS_PER_ITEM + POP_SLACK_MS) +
      TIMEOUT_SLACK_MS
    const cooked = (): number =>
      (countItems(deps.inventory.snapshot()).get(input.produced) ?? 0) - producedBefore
    const stop = (reason: string, message: string): SkillResult<CampfireCookOutput> =>
      err({
        reason,
        message: `${message} Cooked ${String(cooked())} of ${String(requested)} ${input.produced}${onFire.length === 0 ? '' : `; ${String(onFire.length)} still on the fire will pop out beside it`}.`,
        detail: { cooked: cooked(), onFire: onFire.length, fire },
      })

    for (;;) {
      onFire = onFire.filter((at) => clock.now() - at < CAMPFIRE_MS_PER_ITEM + POP_SLACK_MS)
      while (put < requested && onFire.length < CAMPFIRE_SLOTS && !context.signal.aborted) {
        const placed = await deps.fires.put(fire, input.item)
        if (!placed.ok) {
          refusals += 1
          if (refusals >= MAX_REFUSALS)
            return stop(
              'campfire_full',
              `The campfire will not take the ${input.item}: ${placed.error}`,
            )
          break
        }
        refusals = 0
        put += 1
        onFire.push(clock.now())
      }
      context.progress(`Cooked ${String(cooked())} of ${String(requested)} ${input.produced}`)
      if (put >= requested && onFire.length === 0) break
      if (context.signal.aborted) return stop('aborted', 'Cancelled.')
      if (clock.now() > deadline) return stop('timeout', 'The campfire took too long.')

      const oldest = onFire.length === 0 ? undefined : Math.min(...onFire)
      const wait =
        oldest === undefined
          ? REFUSAL_WAIT_MS
          : Math.max(MIN_WAIT_MS, oldest + CAMPFIRE_MS_PER_ITEM + POP_SLACK_MS - clock.now())
      await sleep(scheduler, wait, context.signal)
      await deps.drops.collect(
        { names: [input.produced], maxDistance: PICKUP_RADIUS },
        context.signal,
      )
    }
    await deps.drops.collect(
      { names: [input.produced], maxDistance: PICKUP_RADIUS },
      context.signal,
    )
    return ok({ cooked: cooked(), fire })
  }

  /** Never stand on the fire: a burning campfire hurts. */
  private async stepOff(fire: Position, context: SkillContext): Promise<void> {
    const here = this.deps.vitals.read()?.position
    if (here === undefined) return
    if (
      Math.floor(here.x) !== fire.x ||
      Math.floor(here.z) !== fire.z ||
      Math.floor(here.y) !== fire.y
    )
      return
    await this.deps.navigator.goToPosition({ x: fire.x + 2, y: fire.y, z: fire.z }, 1, {
      signal: context.signal,
    })
  }
}
