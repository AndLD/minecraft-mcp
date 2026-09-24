import type { PlaceFailure, PlaceOptions, Placer } from '../core/placer.port.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { BlockLike, BotHolder, BotLike } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

const fail = (reason: PlaceFailure['reason'], message: string): Result<never, PlaceFailure> =>
  err({ reason, message })

const UP = toVec3({ x: 0, y: 1, z: 0 })
/** The server needs a moment to turn the bot and to act on the bucket. */
const BUCKET_TICKS = 5
/** The server must have learned that the bot sneaks before the click arrives. */
const SNEAK_TICKS = 3

export class MineflayerPlacer implements Placer {
  constructor(private readonly holder: BotHolder) {}

  async placeAt(itemName: string, target: Position): Promise<Result<void, PlaceFailure>> {
    const bot = this.holder.current()
    if (bot === undefined) return fail('not_connected', 'Not connected to a Minecraft world.')

    const id = bot.registry.itemsByName[itemName]?.id
    if (id === undefined || !bot.inventory.items().some((item) => item.name === itemName))
      return fail('no_item', `The bot has no ${itemName} to place.`)

    const below = bot.blockAt(toVec3({ x: target.x, y: target.y - 1, z: target.z }))
    if (below === null || below.boundingBox !== 'block')
      return fail('no_support', 'There is no solid block to place it against.')

    return this.place(bot, id, below, UP)
  }

  async placeAgainst(
    itemName: string,
    reference: Position,
    face: Position,
    options: PlaceOptions = {},
  ): Promise<Result<void, PlaceFailure>> {
    const bot = this.holder.current()
    if (bot === undefined) return fail('not_connected', 'Not connected to a Minecraft world.')

    const id = bot.registry.itemsByName[itemName]?.id
    if (id === undefined || !bot.inventory.items().some((item) => item.name === itemName))
      return fail('no_item', `The bot has no ${itemName} to place.`)

    const block = bot.blockAt(toVec3(reference))
    if (block === null || block.boundingBox !== 'block')
      return fail('no_support', 'There is no solid block to place it against.')
    if (options.sneak !== true) return this.place(bot, id, block, toVec3(face))

    bot.setControlState('sneak', true)
    try {
      await bot.waitForTicks(SNEAK_TICKS)
      return await this.place(bot, id, block, toVec3(face))
    } finally {
      bot.setControlState('sneak', false)
    }
  }

  private async place(
    bot: BotLike,
    itemId: number,
    against: BlockLike,
    face: Position,
  ): Promise<Result<void, PlaceFailure>> {
    try {
      await bot.equip(itemId, 'hand')
      const item = bot.registry.items[itemId]?.name ?? ''
      if (item.endsWith('_bucket')) {
        // A bucket is not placed against a block: it is used, on the face the bot looks at. Water then flows out
        // into the cell next to that face.
        const reference = (against as { position?: Position }).position
        if (reference === undefined)
          return fail('failed', 'The block to place against has no position.')
        await bot.lookAt(
          toVec3({
            x: reference.x + 0.5 + face.x * 0.5,
            y: reference.y + 0.5 + face.y * 0.5,
            z: reference.z + 0.5 + face.z * 0.5,
          }),
          true,
        )
        bot.activateItem()
        await bot.waitForTicks(BUCKET_TICKS)
        return ok(undefined)
      }
      await bot.placeBlock(against, face)
      return ok(undefined)
    } catch (error) {
      return fail('failed', error instanceof Error ? error.message : String(error))
    }
  }
}
