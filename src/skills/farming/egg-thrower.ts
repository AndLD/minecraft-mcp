import type { Gaze } from '../../core/gaze.port.js'
import type { InventoryWriter } from '../../core/inventory-writer.port.js'
import type { Position } from '../../core/position.types.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import { sleep } from '../../core/sleep.js'

/** A short pause between throws, matching `ItemThrower`'s own pacing. */
const PAUSE_MS = 300

export interface EggThrowerDeps {
  readonly gaze: Gaze
  readonly writer: InventoryWriter
  readonly scheduler: Scheduler
}

/**
 * Throws eggs into a pen one at a time: faces the target cell, then uses the egg from the hand (a single click,
 * via `InventoryWriter.toss('egg', 1)`), with a short pause between throws. Unlike `ItemThrower` (which tosses a
 * whole stack in one call with no facing), this needs to look before every single egg.
 */
export class EggThrower {
  constructor(private readonly deps: EggThrowerDeps) {}

  /** Throws up to `count` eggs at `target`. Returns how many actually left the inventory. */
  async throw(count: number, target: Position, signal: AbortSignal): Promise<number> {
    let thrown = 0
    for (let i = 0; i < count; i += 1) {
      if (signal.aborted) break
      await this.deps.gaze.lookAt(target)
      const tossed = await this.deps.writer.toss('egg', 1)
      if (tossed <= 0) break
      thrown += 1
      await sleep(this.deps.scheduler, PAUSE_MS, signal)
    }
    return thrown
  }
}
