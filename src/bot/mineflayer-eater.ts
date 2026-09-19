import type { Eater } from '../core/food.port.js'
import { err, ok, type Result } from '../core/result.js'
import type { BotHolder } from './bot-like.types.js'
import { formatReason } from './format-reason.js'

export class MineflayerEater implements Eater {
  constructor(private readonly holder: BotHolder) {}

  async eat(item: string): Promise<Result<void>> {
    const bot = this.holder.current()
    if (bot === undefined) return err('Not connected to a Minecraft world.')
    const id = bot.registry.itemsByName[item]?.id
    if (id === undefined) return err(`${item} is not an item.`)
    try {
      await bot.equip(id, 'hand')
      await bot.consume()
      return ok(undefined)
    } catch (error) {
      return err(`Could not eat ${item}: ${formatReason(error)}`)
    }
  }
}
