import type { DroppedItem, DroppedItemScanner } from '../../core/dropped-items.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import { sleep } from '../../core/sleep.js'

/** Dropped items take a moment to appear after a block breaks. */
const DROP_APPEAR_MS = 350
/** After walking onto an item the game needs a moment to add it to the inventory. */
const PICKUP_SETTLE_MS = 250
const PICKUP_RANGE = 0.5
/** Items within this many blocks of a broken block count as its drops. */
const DROP_RADIUS = 6
const MAX_TRIPS = 12

export interface DropFilter {
  readonly names?: readonly string[] | undefined
  readonly maxDistance: number
  /** An extra test, for example "near this spot" or "not something the bot threw away on purpose". */
  readonly accept?: ((item: DroppedItem) => boolean) | undefined
}

export interface DropCollectorDeps {
  readonly drops: DroppedItemScanner
  readonly navigator: Navigator
  readonly scheduler: Scheduler
}

/** Walks onto dropped items so the game picks them up. Each item is tried once, so an unreachable one cannot loop forever. */
export class DropCollector {
  constructor(private readonly deps: DropCollectorDeps) {}

  /** Picks up what a block dropped when it broke at `origin`. */
  async collectNear(origin: Position, signal: AbortSignal): Promise<void> {
    await sleep(this.deps.scheduler, DROP_APPEAR_MS, signal)
    await this.sweep(
      () =>
        this.deps.drops
          .nearby(DROP_RADIUS * 2)
          .filter((item) => distanceBetween(item.position, origin) <= DROP_RADIUS),
      signal,
    )
  }

  /** Picks up every matching item within `maxDistance` of the bot. */
  async collect(filter: DropFilter, signal: AbortSignal): Promise<void> {
    await this.sweep(() => this.matching(filter), signal)
  }

  matching(filter: DropFilter): readonly DroppedItem[] {
    const names = filter.names
    return this.deps.drops
      .nearby(filter.maxDistance)
      .filter((item) => names === undefined || names.length === 0 || names.includes(item.name))
      .filter((item) => filter.accept === undefined || filter.accept(item))
  }

  private async sweep(
    candidates: () => readonly DroppedItem[],
    signal: AbortSignal,
  ): Promise<void> {
    const tried = new Set<number>()
    for (let trip = 0; trip < MAX_TRIPS; trip += 1) {
      if (signal.aborted) return
      const next = candidates().find((item) => !tried.has(item.entityId))
      if (next === undefined) return
      tried.add(next.entityId)
      const walked = await this.deps.navigator.goToPosition(next.position, PICKUP_RANGE, { signal })
      if (!walked.ok && walked.error.reason === 'aborted') return
      await sleep(this.deps.scheduler, PICKUP_SETTLE_MS, signal)
    }
  }
}
