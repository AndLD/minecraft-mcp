import type { ItemFacts } from '../core/item-facts.port.js'
import type { BotHolder } from './bot-like.types.js'

const DEFAULT_STACK = 64

export class MineflayerItemFacts implements ItemFacts {
  constructor(private readonly holder: BotHolder) {}

  isItem(name: string): boolean {
    return this.holder.current()?.registry.itemsByName[name] !== undefined
  }

  isFood(name: string): boolean {
    return this.holder.current()?.registry.foodsByName[name] !== undefined
  }

  isBlock(name: string): boolean {
    return this.holder.current()?.registry.blocksByName[name] !== undefined
  }

  allItems(): readonly string[] {
    const bot = this.holder.current()
    return bot === undefined ? [] : Object.keys(bot.registry.itemsByName)
  }

  stackSize(name: string): number {
    const bot = this.holder.current()
    const id = bot?.registry.itemsByName[name]?.id
    return (id === undefined ? undefined : bot?.registry.items[id]?.stackSize) ?? DEFAULT_STACK
  }
}
