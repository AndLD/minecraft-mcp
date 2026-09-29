import type { DoorAccess, DoorFailure, DoorState } from '../core/door.port.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

/**
 * How many ticks (50 ms each) to wait, at most, for the block to change after the click. The server's answer can be
 * late under load; a caller that reads the state too early sees no change and clicks again, which undoes the first.
 */
const CONFIRM_TICKS = 8

export class MineflayerDoorAccess implements DoorAccess {
  constructor(private readonly holder: BotHolder) {}

  stateAt(position: Position): DoorState | undefined {
    const block = this.holder.current()?.blockAt(toVec3(position))
    if (block === null || block === undefined) return undefined
    const open = block.getProperties?.()['open']
    return { name: block.name, open: open === true }
  }

  async toggle(position: Position, signal: AbortSignal): Promise<Result<void, DoorFailure>> {
    const bot = this.holder.current()
    if (bot === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
    const block = bot.blockAt(toVec3(position))
    const before = block?.getProperties?.()['open']
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
    for (let tick = 0; tick < CONFIRM_TICKS; tick += 1) {
      await bot.waitForTicks(1)
      if (bot.blockAt(toVec3(position))?.getProperties?.()['open'] !== before) break
    }
    return ok(undefined)
  }
}

const describe = (position: Position): string =>
  `${String(position.x)}, ${String(position.y)}, ${String(position.z)}`
