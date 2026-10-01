import type { BedAccess, BedFailure, BedState } from '../core/bed.port.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { Scheduler } from '../core/scheduler.port.js'
import { sleep } from '../core/sleep.js'
import type { BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

/** How long the server's answer to the click is listened for. */
const REPLY_WAIT_MS = 1_200

export class MineflayerBedAccess implements BedAccess {
  constructor(
    private readonly holder: BotHolder,
    private readonly scheduler: Scheduler,
  ) {}

  stateAt(position: Position): BedState | undefined {
    const block = this.holder.current()?.blockAt(toVec3(position))
    if (block === null || block === undefined || !block.name.endsWith('_bed')) return undefined
    const properties = block.getProperties?.() ?? {}
    const part = properties['part']
    return {
      name: block.name,
      part: part === 'head' || part === 'foot' ? part : undefined,
      occupied: properties['occupied'] === true,
    }
  }

  async use(
    position: Position,
    signal: AbortSignal,
  ): Promise<Result<readonly string[], BedFailure>> {
    const bot = this.holder.current()
    if (bot === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
    const block = bot.blockAt(toVec3(position))
    if (block === null) return err({ reason: 'out_of_reach', message: 'That place is not loaded.' })

    const lines: string[] = []
    const onLine = (line: unknown): void => {
      lines.push(String(line))
    }
    bot.on('messagestr', onLine)
    bot.on('actionBar', onLine)
    try {
      await bot.activateBlock(block)
      await sleep(this.scheduler, REPLY_WAIT_MS, signal)
      return ok(lines)
    } catch (error) {
      return err({
        reason: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      bot.removeListener('messagestr', onLine)
      bot.removeListener('actionBar', onLine)
    }
  }
}
