import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { SleepFailure, Sleeper } from '../core/sleeper.port.js'
import type { BotHolder } from './bot-like.types.js'
import { classifySleepFailure } from './sleep-failure.js'
import { toVec3 } from './vec3.js'

export class MineflayerSleeper implements Sleeper {
  constructor(private readonly holder: BotHolder) {}

  isSleeping(): boolean {
    return this.holder.current()?.isSleeping === true
  }

  async sleep(bed: Position): Promise<Result<void, SleepFailure>> {
    const bot = this.holder.current()
    if (bot === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
    const block = bot.blockAt(toVec3(bed))
    if (block === null || !block.name.endsWith('_bed'))
      return err({ reason: 'not_a_bed', message: 'There is no bed at that position.' })

    // The refusals (monsters nearby, too far) come as lines on the action bar, not as errors.
    const lines: string[] = []
    const onLine = (line: unknown): void => {
      lines.push(String(line))
    }
    bot.on('messagestr', onLine)
    bot.on('actionBar', onLine)
    try {
      await bot.sleep(block)
      return ok(undefined)
    } catch (error) {
      const text = [error instanceof Error ? error.message : String(error), ...lines].join(' | ')
      return err({ reason: classifySleepFailure(text), message: text })
    } finally {
      bot.removeListener('messagestr', onLine)
      bot.removeListener('actionBar', onLine)
    }
  }

  async wake(): Promise<void> {
    const bot = this.holder.current()
    if (bot?.isSleeping !== true) return
    try {
      await bot.wake()
    } catch {
      // Already awake by the time the request arrived.
    }
  }
}
