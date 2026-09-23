import type { SwitchAccess, SwitchFailure, SwitchState } from '../core/switch.port.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

/**
 * How many ticks (50 ms each) to wait after the click before reading state back. Longer than a door's own
 * confirm wait: a caller usually reads a *different* block (the door the switch powers), one more hop of
 * redstone propagation away from the click itself, and needs the extra margin to see it settle.
 */
const CONFIRM_TICKS = 6

export class MineflayerSwitchAccess implements SwitchAccess {
  constructor(private readonly holder: BotHolder) {}

  stateAt(position: Position): SwitchState | undefined {
    const block = this.holder.current()?.blockAt(toVec3(position))
    if (block === null || block === undefined) return undefined
    const powered = block.getProperties?.()['powered']
    return { name: block.name, powered: powered === true }
  }

  async press(position: Position, signal: AbortSignal): Promise<Result<void, SwitchFailure>> {
    const bot = this.holder.current()
    if (bot === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
    const block = bot.blockAt(toVec3(position))
    if (block === null)
      return err({ reason: 'out_of_reach', message: `${describe(position)} is not loaded.` })
    try {
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
