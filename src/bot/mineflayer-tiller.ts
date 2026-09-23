import type { TillFailure, Tiller } from '../core/tiller.port.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

/** How many ticks (50 ms each) to wait after the click before reading the block's new state back. */
const CONFIRM_TICKS = 2

export class MineflayerTiller implements Tiller {
  constructor(private readonly holder: BotHolder) {}

  async till(position: Position, signal: AbortSignal): Promise<Result<void, TillFailure>> {
    const bot = this.holder.current()
    if (bot === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
    const hoe = bot.inventory.items().find((item) => item.name.endsWith('_hoe'))
    if (hoe === undefined)
      return err({ reason: 'no_hoe', message: 'The bot has no hoe to till with.' })
    const block = bot.blockAt(toVec3(position))
    if (block === null)
      return err({ reason: 'out_of_reach', message: `${describe(position)} is not loaded.` })
    try {
      const id = bot.registry.itemsByName[hoe.name]?.id
      if (id !== undefined) await bot.equip(id, 'hand')
      await bot.activateBlock(block)
    } catch (error) {
      return err({
        reason: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
    if (signal.aborted) return err({ reason: 'failed', message: 'Cancelled.' })
    await bot.waitForTicks(CONFIRM_TICKS)
    return ok(undefined)
  }
}

const describe = (position: Position): string =>
  `${String(position.x)}, ${String(position.y)}, ${String(position.z)}`
