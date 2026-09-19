import type { InventoryWriter } from '../core/inventory-writer.port.js'
import type { BotHolder } from './bot-like.types.js'
import { WindowDropper } from './window-dropper.js'

export class MineflayerInventoryWriter implements InventoryWriter {
  constructor(private readonly holder: BotHolder) {}

  toss(item: string, count: number): Promise<number> {
    const bot = this.holder.current()
    return bot === undefined
      ? Promise.resolve(0)
      : new WindowDropper(bot.inventoryWindow).toss(item, count)
  }
}
