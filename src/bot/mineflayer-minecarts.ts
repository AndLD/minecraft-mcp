import type { MinecartFailure, MinecartPlacer } from '../core/minecart.port.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

/** Ticks (50 ms each) to wait for the cart to appear after the click. */
const CONFIRM_TICKS = 6
const NEAR = 2.5

export class MineflayerMinecarts implements MinecartPlacer {
  constructor(private readonly holder: BotHolder) {}

  async place(rail: Position, signal: AbortSignal): Promise<Result<void, MinecartFailure>> {
    const bot = this.holder.current()
    if (bot === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
    const cart = bot.inventory.items().find((item) => item.name === 'minecart')
    if (cart === undefined)
      return err({ reason: 'no_minecart', message: 'The bot has no minecart to place.' })
    const block = bot.blockAt(toVec3(rail))
    if (block === null)
      return err({ reason: 'out_of_reach', message: `${describe(rail)} is not loaded.` })
    if (!block.name.endsWith('rail'))
      return err({
        reason: 'not_a_rail',
        message: `${block.name} at ${describe(rail)} is not a rail.`,
      })
    try {
      const id = bot.registry.itemsByName['minecart']?.id
      if (id !== undefined) await bot.equip(id, 'hand')
      await bot.activateBlock(block)
    } catch (error) {
      return err({
        reason: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
    for (let tick = 0; tick < CONFIRM_TICKS; tick += 1) {
      if (signal.aborted) return err({ reason: 'failed', message: 'Cancelled.' })
      await bot.waitForTicks(1)
      const placed = Object.values(bot.entities).some(
        (entity) =>
          entity.name === 'minecart' &&
          Math.abs(entity.position.x - (rail.x + 0.5)) <= NEAR &&
          Math.abs(entity.position.z - (rail.z + 0.5)) <= NEAR &&
          Math.abs(entity.position.y - rail.y) <= NEAR,
      )
      if (placed) return ok(undefined)
    }
    return err({ reason: 'failed', message: `No minecart appeared at ${describe(rail)}.` })
  }
}

const describe = (position: Position): string =>
  `${String(position.x)}, ${String(position.y)}, ${String(position.z)}`
