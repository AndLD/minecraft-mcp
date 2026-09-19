import type { PlaceFailure, Placer } from '../core/placer.port.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

const fail = (reason: PlaceFailure['reason'], message: string): Result<never, PlaceFailure> =>
  err({ reason, message })

const UP = toVec3({ x: 0, y: 1, z: 0 })

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

    try {
      await bot.equip(id, 'hand')
      await bot.placeBlock(below, UP)
      return ok(undefined)
    } catch (error) {
      return fail('failed', error instanceof Error ? error.message : String(error))
    }
  }
}
