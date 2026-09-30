import type { AreaGuard } from '../../core/area-guard.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Clock } from '../../core/clock.port.js'
import type { Fisher } from '../../core/fisher.port.js'
import type { Gaze } from '../../core/gaze.port.js'
import { countItems, gained } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import { sleep } from '../../core/sleep.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { ItemSmelter } from '../smelting/smelt-items-skill.js'
import { kindOfCatch } from './catch-table.js'
import { findFishingSpot } from './fishing-spot.js'

/** A cast with no bite after this long is reeled in and thrown again. */
const CAST_TIMEOUT_MS = 60_000
/** Time for the catch to reach the inventory after the line is reeled in. */
const SETTLE_MS = 1_000
/** Casts in a row that failed for another reason than a missing bite, before the task gives up. */
const MAX_FAILED_CASTS = 3
const RAW_FISH = ['cod', 'salmon']

export interface FishInput {
  /** Stop after this many fish (or of `item` when given). */
  readonly count: number
  /** Count only this catch. Anything else that comes up is kept. */
  readonly item: string | undefined
  readonly maxMinutes: number
  /** Bake the raw fish in a furnace when done. */
  readonly cook: boolean
  /** Fish near here instead of the nearest water. */
  readonly at: Position | undefined
}

export type FishStop = 'count' | 'time' | 'rod_broke' | 'inventory_full' | 'cast_failed'

export interface FishOutput {
  readonly stopped: FishStop
  /** Fish counted towards the goal (of `item` when given). */
  readonly caught: number
  readonly fish: number
  readonly treasure: number
  readonly junk: number
  readonly casts: number
  /** Everything the inventory gained. */
  readonly gained: readonly ItemCount[]
  readonly spot: { readonly stand: Position; readonly water: Position }
  readonly cooked: readonly ItemCount[]
  /** Set when cooking was asked for but failed; the fishing itself succeeded. */
  readonly cookProblem?: string
}

export interface FishDeps {
  readonly blocks: BlockScanner
  readonly navigator: Navigator
  readonly gaze: Gaze
  readonly fisher: Fisher
  readonly inventory: InventoryReader
  readonly vitals: VitalsReader
  readonly guard: AreaGuard
  readonly scheduler: Scheduler
  readonly clock: Clock
  readonly smelter: ItemSmelter
}

/**
 * Fishes from the shore: finds open water and a place to stand, then casts, waits for the bite (a cast that has not
 * bitten in a minute is reeled in and thrown again), reels in, and reads what came up from the inventory. It never
 * enters the water, and it needs a rod (it does not craft one). Stops when it has enough, when time is up, when the
 * rod breaks, or when there is no room for the catch.
 */
export class FishSkill implements Skill<FishInput, FishOutput> {
  readonly name = 'fish'

  constructor(private readonly deps: FishDeps) {}

  async run(input: FishInput, context: SkillContext): Promise<SkillResult<FishOutput>> {
    const { deps } = this
    if (!this.hasRod())
      return err({
        reason: 'no_rod',
        message:
          'There is no fishing rod in the inventory. It is made from 3 sticks and 2 string (string comes from spiders and cobwebs, or chests).',
      })
    const here = deps.vitals.read()?.position
    if (here === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })

    const start = await this.walkNear(input.at, context)
    if (start !== undefined) return start
    const origin = deps.vitals.read()?.position ?? here
    const spot = findFishingSpot(deps.blocks, deps.guard, origin)
    if (spot === undefined)
      return err({
        reason: 'no_water',
        message:
          'No suitable water in sight: it needs open water at least 3 blocks wide with firm ground beside it, outside protected areas. Try another place (at) or explore for a lake.',
      })
    const walked = await deps.navigator.goToPosition(
      { x: spot.stand.x + 0.5, y: spot.stand.y, z: spot.stand.z + 0.5 },
      0.6,
      { signal: context.signal },
    )
    if (!walked.ok)
      return err({
        reason: walked.error.reason === 'aborted' ? 'aborted' : 'unreachable',
        message: `Could not get to the fishing spot: ${walked.error.message}`,
      })

    const before = countItems(deps.inventory.snapshot())
    const deadline = deps.clock.now() + input.maxMinutes * 60_000
    let stopped: FishStop | undefined
    let casts = 0
    let failed = 0
    let caught = 0
    const kinds = { fish: 0, treasure: 0, junk: 0 }

    while (stopped === undefined) {
      if (context.signal.aborted) return this.aborted(kinds, caught, casts, before)
      if (caught >= input.count) stopped = 'count'
      else if (deps.clock.now() >= deadline) stopped = 'time'
      else if (!this.hasRod()) stopped = 'rod_broke'
      else if ((deps.inventory.snapshot()?.emptySlots ?? 1) === 0) stopped = 'inventory_full'
      if (stopped !== undefined) break

      await deps.gaze.lookAt({ x: spot.water.x + 0.5, y: spot.water.y + 1, z: spot.water.z + 0.5 })
      const beforeCast = countItems(deps.inventory.snapshot())
      const cast = await this.cast(context)
      casts += 1
      if (cast === 'aborted') return this.aborted(kinds, caught, casts, before)
      if (cast === 'failed') {
        failed += 1
        if (failed >= MAX_FAILED_CASTS) stopped = 'cast_failed'
        continue
      }
      failed = 0
      if (cast === 'timeout') continue

      await sleep(deps.scheduler, SETTLE_MS, context.signal)
      for (const item of gained(beforeCast, countItems(deps.inventory.snapshot()))) {
        kinds[kindOfCatch(item.name)] += item.count
        if (input.item === undefined ? kindOfCatch(item.name) === 'fish' : item.name === input.item)
          caught += item.count
      }
      context.progress(`Caught ${String(caught)} of ${String(input.count)}`)
    }

    const total = gained(before, countItems(deps.inventory.snapshot()))
    const cooking = input.cook ? await this.cook(total, context) : { cooked: [] }
    return ok({
      stopped,
      caught,
      ...kinds,
      casts,
      gained: total,
      spot,
      ...cooking,
    })
  }

  private hasRod(): boolean {
    return (this.deps.inventory.snapshot()?.stacks ?? []).some(
      (stack) => stack.name === 'fishing_rod',
    )
  }

  /** Walks to the given place first, when there is one. Returns a failure to end the task, or undefined. */
  private async walkNear(
    at: Position | undefined,
    context: SkillContext,
  ): Promise<SkillResult<FishOutput> | undefined> {
    if (at === undefined) return undefined
    const walked = await this.deps.navigator.goToPosition(at, 6, { signal: context.signal })
    if (walked.ok) return undefined
    return err({
      reason: walked.error.reason === 'aborted' ? 'aborted' : 'unreachable',
      message: `Could not get to ${String(at.x)}, ${String(at.y)}, ${String(at.z)}: ${walked.error.message}`,
    })
  }

  /** One cast. A bite that never comes ends after the timeout, with the line reeled in. */
  private async cast(context: SkillContext): Promise<'bite' | 'timeout' | 'failed' | 'aborted'> {
    const line = new AbortController()
    const flags = { timedOut: false, cancelled: false }
    const cancelTimer = this.deps.scheduler.after(CAST_TIMEOUT_MS, () => {
      flags.timedOut = true
      line.abort()
    })
    const forward = (): void => {
      flags.cancelled = true
      line.abort()
    }
    context.signal.addEventListener('abort', forward, { once: true })
    try {
      const result = await this.deps.fisher.cast(line.signal)
      if (result.ok) return 'bite'
      if (flags.cancelled || context.signal.aborted) return 'aborted'
      if (flags.timedOut) return 'timeout'
      return 'failed'
    } finally {
      cancelTimer()
      context.signal.removeEventListener('abort', forward)
    }
  }

  private aborted(
    kinds: { fish: number; treasure: number; junk: number },
    caught: number,
    casts: number,
    before: ReadonlyMap<string, number>,
  ): SkillResult<FishOutput> {
    return err({
      reason: 'aborted',
      message: `Cancelled after ${String(casts)} cast(s) and ${String(caught)} catch(es).`,
      detail: {
        ...kinds,
        caught,
        casts,
        gained: gained(before, countItems(this.deps.inventory.snapshot())),
      },
    })
  }

  /** Bakes the raw fish that came in. A failure is reported, not fatal. */
  private async cook(
    total: readonly ItemCount[],
    context: SkillContext,
  ): Promise<{ cooked: ItemCount[]; cookProblem?: string }> {
    const cooked: ItemCount[] = []
    for (const raw of total.filter((entry) => RAW_FISH.includes(entry.name))) {
      if (context.signal.aborted) break
      context.progress(`Cooking ${String(raw.count)} ${raw.name}`)
      const result = await this.deps.smelter.run(
        { item: raw.name, count: raw.count, fuel: undefined },
        context,
      )
      if (!result.ok) return { cooked, cookProblem: `${raw.name}: ${result.error.message}` }
      cooked.push({ name: result.value.produced, count: result.value.smelted })
    }
    return { cooked }
  }
}
