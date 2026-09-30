import type { FishFailure, Fisher } from '../core/fisher.port.js'
import { err, ok, type Result } from '../core/result.js'
import type { BotHolder } from './bot-like.types.js'
import { formatReason } from './format-reason.js'

export class MineflayerFisher implements Fisher {
  constructor(private readonly holder: BotHolder) {}

  async cast(signal: AbortSignal): Promise<Result<void, FishFailure>> {
    const bot = this.holder.current()
    if (bot === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
    const rod = bot.registry.itemsByName['fishing_rod']
    if (rod === undefined)
      return err({ reason: 'no_rod', message: 'This game version has no fishing rod.' })
    try {
      await bot.equip(rod.id, 'hand')
    } catch (error) {
      return err({ reason: 'no_rod', message: `Could not take the rod: ${formatReason(error)}` })
    }
    if (signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })

    // Using the rod again pulls the line in, which ends the pending cast with an error.
    const line = { reeled: false }
    const reel = (): void => {
      line.reeled = true
      bot.activateItem()
    }
    signal.addEventListener('abort', reel, { once: true })
    try {
      await bot.fish()
      return ok(undefined)
    } catch (error) {
      return line.reeled
        ? err({ reason: 'aborted', message: 'The line was reeled in.' })
        : err({ reason: 'failed', message: `The cast failed: ${formatReason(error)}` })
    } finally {
      signal.removeEventListener('abort', reel)
    }
  }
}
