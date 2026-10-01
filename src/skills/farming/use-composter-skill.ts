import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { BlockUser } from '../../core/block-user.port.js'
import type { ComposterAccess } from '../../core/composter.port.js'
import { countItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { AreaGuard } from '../../core/area-guard.port.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import type { DropCollector } from '../gathering/drop-collector.js'
import { compostChance, isScrap } from './compostables.js'

const SEARCH_DISTANCE = 32
const APPROACH_RANGE = 3
const SETTLE_MS = 250
/** A composter that reaches level 7 turns ready about a second later. */
const READY_WAIT_MS = 1_000
const READY_TRIES = 5
const PICKUP_RADIUS = 5
const PICKUP_TRIES = 5
const PICKUP_WAIT_MS = 500
const READY = 8
/** Items go in while the level is below this (7 fills it, and it turns ready by itself). */
const FULL = 7
/** A composted item is gone from the bag whether or not the level rose; this many items on a full-looking block end it. */
const MAX_ITEMS = 500

export interface UseComposterInput {
  /** A composter block; the nearest within 32 blocks when undefined. */
  readonly at: Position | undefined
  /** What to put in (item names); the scraps carried (seeds, saplings, leaves, grass, kelp) when undefined. */
  readonly items: readonly string[] | undefined
  /** Take the bone meal out when the composter is ready. */
  readonly collect: boolean
}

export interface UseComposterOutput {
  /** Items put in, by name. */
  readonly composted: readonly { readonly name: string; readonly count: number }[]
  /** Bone meal that came into the bag. */
  readonly boneMeal: number
  /** The composter's level at the end (8 is ready; 0 after it was emptied). */
  readonly level: number
  readonly composter: Position
}

export interface UseComposterDeps {
  readonly blocks: BlockScanner
  readonly composters: ComposterAccess
  readonly user: BlockUser
  readonly navigator: Navigator
  readonly inventory: InventoryReader
  readonly drops: Pick<DropCollector, 'collect'>
  readonly guard: AreaGuard
  readonly scheduler: Scheduler
}

const carried = (inventory: InventoryReader): Map<string, number> =>
  countItems(inventory.snapshot())

/**
 * Turns scraps into bone meal in a composter: puts items on it one at a time, reading its level from the block state,
 * until it is full; waits for it to turn ready; and, with `collect`, clicks it to take the bone meal, which pops out
 * and is picked up. Never breaks the composter and never composts food or tools unless they are named.
 */
export class UseComposterSkill implements Skill<UseComposterInput, UseComposterOutput> {
  readonly name = 'use_composter'

  constructor(private readonly deps: UseComposterDeps) {}

  async run(
    input: UseComposterInput,
    context: SkillContext,
  ): Promise<SkillResult<UseComposterOutput>> {
    const { deps } = this
    const at =
      input.at ??
      deps.blocks.findBlocks({ names: ['composter'], maxDistance: SEARCH_DISTANCE, count: 1 })[0]
        ?.position
    if (at === undefined)
      return err({
        reason: 'no_composter',
        message: `There is no composter within ${String(SEARCH_DISTANCE)} blocks. One is 7 planks or logs, placed like any block.`,
      })
    if (deps.composters.levelAt(at) === undefined)
      return err({ reason: 'no_composter', message: 'The block there is not a composter.' })
    const area = deps.guard.protectedAt(at)
    if (area !== undefined)
      return err({
        reason: 'protected_area',
        message: `The composter is inside the protected area ${area.label}.`,
      })

    const named = input.items
    if (named !== undefined) {
      const bad = named.find((item) => compostChance(item) === undefined)
      if (bad !== undefined)
        return err({ reason: 'not_compostable', message: `${bad} cannot be composted.` })
    }

    const walked = await deps.navigator.goToPosition(at, APPROACH_RANGE, { signal: context.signal })
    if (!walked.ok)
      return err({
        reason: walked.error.reason === 'aborted' ? 'aborted' : 'unreachable',
        message: `Could not get to the composter: ${walked.error.message}`,
      })

    const composted = new Map<string, number>()
    const level = (): number => deps.composters.levelAt(at) ?? 0
    let used = 0
    for (const item of this.queue(named)) {
      while (level() < FULL && (carried(deps.inventory).get(item) ?? 0) > 0 && used < MAX_ITEMS) {
        if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
        const before = carried(deps.inventory).get(item) ?? 0
        const clicked = await deps.user.use(at, item)
        if (!clicked.ok) break
        await sleep(deps.scheduler, SETTLE_MS, context.signal)
        const gone = before - (carried(deps.inventory).get(item) ?? 0)
        if (gone <= 0) break
        used += gone
        composted.set(item, (composted.get(item) ?? 0) + gone)
        context.progress(`Composted ${String(used)} items, level ${String(level())}`)
      }
      if (level() >= FULL) break
    }
    if (named === undefined && used === 0 && level() < READY)
      return err({
        reason: 'nothing_to_compost',
        message:
          'The bot carries no seeds, saplings, leaves, grass, or kelp to compost. Name the items to use (items).',
      })

    for (let tries = 0; level() === FULL && tries < READY_TRIES; tries += 1)
      await sleep(deps.scheduler, READY_WAIT_MS, context.signal)

    const bonesBefore = carried(deps.inventory).get('bone_meal') ?? 0
    if (input.collect && level() === READY) {
      await deps.user.use(at, undefined)
      // The bone meal pops out as a dropped item that cannot be picked up for a few ticks (found by the e2e run), so
      // look for it again a few times before calling it lost.
      for (let tries = 0; tries < PICKUP_TRIES; tries += 1) {
        await sleep(deps.scheduler, PICKUP_WAIT_MS, context.signal)
        await deps.drops.collect(
          { names: ['bone_meal'], maxDistance: PICKUP_RADIUS },
          context.signal,
        )
        if ((carried(deps.inventory).get('bone_meal') ?? 0) > bonesBefore) break
      }
    }
    return ok({
      composted: [...composted].map(([name, count]) => ({ name, count })),
      boneMeal: Math.max(0, (carried(deps.inventory).get('bone_meal') ?? 0) - bonesBefore),
      level: level(),
      composter: at,
    })
  }

  /** The items to put in, in order: the ones named, or every scrap carried. */
  private queue(named: readonly string[] | undefined): string[] {
    if (named !== undefined) return [...named]
    return [...carried(this.deps.inventory).keys()].filter(isScrap).sort()
  }
}
