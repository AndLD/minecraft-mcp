import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerChat } from '../../../src/bot/mineflayer-chat.js'
import type { IncomingChat } from '../../../src/core/chat.port.js'
import { FakeBot } from '../../fakes/fake-bot.js'

class FakeHolder implements BotHolder {
  bot: BotLike | undefined
  private listeners: ((bot: BotLike | undefined) => void)[] = []

  current(): BotLike | undefined {
    return this.bot
  }

  onChange(listener: (bot: BotLike | undefined) => void): () => void {
    this.listeners.push(listener)
    return () => undefined
  }

  set(bot: BotLike | undefined): void {
    this.bot = bot
    for (const listener of this.listeners) listener(bot)
  }
}

describe('MineflayerChat', () => {
  it('cannot speak without a bot', () => {
    const chat = new MineflayerChat(new FakeHolder())

    expect(chat.say('hi')).toEqual({ ok: false, error: 'Not connected to a Minecraft world.' })
    expect(chat.whisper('Andrey_Knight', 'hi')).toEqual({
      ok: false,
      error: 'Not connected to a Minecraft world.',
    })
  })

  it('speaks and whispers through the current bot', () => {
    const holder = new FakeHolder()
    const bot = new FakeBot()
    holder.set(bot)
    const chat = new MineflayerChat(holder)

    expect(chat.say('hello').ok).toBe(true)
    expect(chat.whisper('Andrey_Knight', 'psst').ok).toBe(true)

    expect(bot.chatLog).toEqual(['hello'])
    expect(bot.whisperLog).toEqual([{ player: 'Andrey_Knight', text: 'psst' }])
  })

  it('reports public chat and whispers from other players', () => {
    const holder = new FakeHolder()
    const chat = new MineflayerChat(holder)
    const received: IncomingChat[] = []
    chat.onMessage((m) => received.push(m))
    const bot = new FakeBot()
    holder.set(bot)

    bot.emit('chat', 'Andrey_Knight', 'come here')
    bot.emit('whisper', 'Andrey_Knight', 'secret')

    expect(received).toEqual([
      { sender: 'Andrey_Knight', text: 'come here', whisper: false },
      { sender: 'Andrey_Knight', text: 'secret', whisper: true },
    ])
  })

  it('never reports the bot’s own messages', () => {
    const holder = new FakeHolder()
    const chat = new MineflayerChat(holder)
    const received: IncomingChat[] = []
    chat.onMessage((m) => received.push(m))
    const bot = new FakeBot()
    holder.set(bot)

    bot.emit('chat', 'ClaudeBot', 'my own words')

    expect(received).toEqual([])
  })

  it('attaches to a bot that is already current when created', () => {
    const holder = new FakeHolder()
    const bot = new FakeBot()
    holder.bot = bot
    const chat = new MineflayerChat(holder)
    const received: IncomingChat[] = []
    chat.onMessage((m) => received.push(m))

    bot.emit('chat', 'A', 'hi')

    expect(received).toHaveLength(1)
  })

  it('follows the bot across reconnects and detaches from the old one', () => {
    const holder = new FakeHolder()
    const chat = new MineflayerChat(holder)
    const received: string[] = []
    chat.onMessage((m) => received.push(m.text))
    const first = new FakeBot()
    const second = new FakeBot()

    holder.set(first)
    holder.set(undefined)
    holder.set(second)
    first.emit('chat', 'A', 'from the old bot')
    second.emit('chat', 'A', 'from the new bot')

    expect(received).toEqual(['from the new bot'])
    expect(first.listenerCount('chat')).toBe(0)
    expect(first.listenerCount('whisper')).toBe(0)
  })

  it('stops notifying unsubscribed listeners', () => {
    const holder = new FakeHolder()
    const chat = new MineflayerChat(holder)
    const received: string[] = []
    const stop = chat.onMessage((m) => received.push(m.text))
    const bot = new FakeBot()
    holder.set(bot)
    stop()

    bot.emit('chat', 'A', 'hi')

    expect(received).toEqual([])
  })
})
