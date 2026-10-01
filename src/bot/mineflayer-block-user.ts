import type { BlockUser } from '../core/block-user.port.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

/** Ticks to let the server answer a click before the caller reads the block again. */
const SETTLE_TICKS = 3

export class MineflayerBlockUser implements BlockUser {
  constructor(private readonly holder: BotHolder) {}

  async use(position: Position, item: string | undefined): Promise<Result<void>> {
    const bot = this.holder.current()
    if (bot === undefined) return err('Not connected to a Minecraft world.')
    const block = bot.blockAt(toVec3(position))
    if (block === null) return err('That block is not loaded.')
    try {
      if (item !== undefined) {
        const id = bot.registry.itemsByName[item]?.id
        if (id === undefined || !bot.inventory.items().some((held) => held.name === item))
          return err(`The bot has no ${item} to use.`)
        await bot.equip(id, 'hand')
      }
      // The server checks the click against where the bot looks, so face the block first.
      await bot.lookAt(
        toVec3({ x: position.x + 0.5, y: position.y + 0.5, z: position.z + 0.5 }),
        true,
      )
      await bot.activateBlock(block)
      await bot.waitForTicks(SETTLE_TICKS)
      return ok(undefined)
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error))
    }
  }
}
