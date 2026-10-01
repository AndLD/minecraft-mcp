import type { Unsubscribe } from '../core/connection.port.js'
import type { ChatPort, IncomingChat } from '../core/chat.port.js'
import { err, ok, type Result } from '../core/result.js'
import type { BotHolder, BotLike } from './bot-like.types.js'

/** Chat through whichever bot is current. Listeners survive reconnects. */
export class MineflayerChat implements ChatPort {
  private readonly listeners = new Set<(message: IncomingChat) => void>()
  private detach: (() => void) | undefined

  constructor(private readonly holder: BotHolder) {
    holder.onChange((bot) => {
      this.attach(bot)
    })
    this.attach(holder.current())
  }

  say(text: string): Result<void> {
    const bot = this.holder.current()
    if (bot === undefined) return err('Not connected to a Minecraft world.')
    bot.chat(text)
    return ok(undefined)
  }

  whisper(player: string, text: string): Result<void> {
    const bot = this.holder.current()
    if (bot === undefined) return err('Not connected to a Minecraft world.')
    bot.whisper(player, text)
    return ok(undefined)
  }

  onMessage(listener: (message: IncomingChat) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private attach(bot: BotLike | undefined): void {
    this.detach?.()
    this.detach = undefined
    if (bot === undefined) return

    const onChat = (sender: string, text: string): void => {
      this.dispatch(bot, { sender, text, whisper: false })
    }
    const onWhisper = (sender: string, text: string): void => {
      this.dispatch(bot, { sender, text, whisper: true })
    }
    bot.on('chat', onChat)
    bot.on('whisper', onWhisper)
    this.detach = () => {
      bot.removeListener('chat', onChat)
      bot.removeListener('whisper', onWhisper)
    }
  }

  private dispatch(bot: BotLike, message: IncomingChat): void {
    if (message.sender === bot.username) return
    for (const listener of this.listeners) listener(message)
  }
}
