import type { InventoryReader, InventorySnapshot } from '../core/inventory.port.js'
import type { BotHolder } from './bot-like.types.js'

export class MineflayerInventory implements InventoryReader {
  constructor(private readonly holder: BotHolder) {}

  snapshot(): InventorySnapshot | undefined {
    const bot = this.holder.current()
    if (bot === undefined) return undefined
    return {
      stacks: bot.inventory.items().map((item) => ({ name: item.name, count: item.count })),
      emptySlots: bot.inventory.emptySlotCount(),
      heldItem: bot.heldItem?.name,
    }
  }
}
