import type { InventoryWriter } from '../../core/inventory-writer.port.js'
import type { ItemCount } from '../../core/recipes.port.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import { sleep } from '../../core/sleep.js'

/** A short pause between throws, so the drops do not pile up into one entity and the server keeps up. */
const PAUSE_MS = 300

/** Throws a list of items out one after another and reports what really left the inventory. */
export class ItemThrower {
  constructor(
    private readonly writer: InventoryWriter,
    private readonly scheduler: Scheduler,
  ) {}

  async throwAll(items: readonly ItemCount[], signal: AbortSignal): Promise<ItemCount[]> {
    const thrown: ItemCount[] = []
    for (const item of items) {
      if (signal.aborted) break
      const count = await this.writer.toss(item.name, item.count)
      if (count > 0) thrown.push({ name: item.name, count })
      await sleep(this.scheduler, PAUSE_MS, signal)
    }
    return thrown
  }
}
