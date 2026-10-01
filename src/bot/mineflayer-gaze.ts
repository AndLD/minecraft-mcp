import type { Gaze } from '../core/gaze.port.js'
import type { Position } from '../core/position.types.js'
import type { BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

/** Game ticks (50 ms) to let the server catch up with where the bot looks. */
const SETTLE_TICKS = 4

export class MineflayerGaze implements Gaze {
  constructor(private readonly holder: BotHolder) {}

  async lookAt(target: Position): Promise<void> {
    const bot = this.holder.current()
    if (bot === undefined) return
    await bot.lookAt(toVec3(target), true)
    // The server learns the new direction with the bot's next movement packets; a throw sent before that flies the old way.
    await bot.waitForTicks(SETTLE_TICKS)
  }
}
