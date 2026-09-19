import { EventEmitter } from 'node:events'
import type { BotEvents, BotLike } from '../../src/bot/bot-like.types.js'

/** A stub of the game bot: tests drive it by emitting events and read what it was asked to do. */
export class FakeBot implements BotLike {
  username = 'ClaudeBot'
  version = '1.21.1'
  health = 20
  food = 20
  entity: BotLike['entity'] = { position: { x: 10, y: 64, z: -5 } }
  game = { dimension: 'overworld' }
  time = { timeOfDay: 6000 }

  readonly chatLog: string[] = []
  readonly whisperLog: { player: string; text: string }[] = []
  quitCalls = 0
  /** When true, quit() ends the session like a real bot does. */
  endOnQuit = true

  private readonly emitter = new EventEmitter()

  chat(message: string): void {
    this.chatLog.push(message)
  }

  whisper(player: string, text: string): void {
    this.whisperLog.push({ player, text })
  }

  quit(): void {
    this.quitCalls += 1
    if (this.endOnQuit) this.emit('end', 'quit')
  }

  on<E extends keyof BotEvents>(event: E, listener: BotEvents[E]): this {
    this.emitter.on(event, listener)
    return this
  }

  once<E extends keyof BotEvents>(event: E, listener: BotEvents[E]): this {
    this.emitter.once(event, listener)
    return this
  }

  removeListener<E extends keyof BotEvents>(event: E, listener: BotEvents[E]): this {
    this.emitter.removeListener(event, listener)
    return this
  }

  emit<E extends keyof BotEvents>(event: E, ...args: Parameters<BotEvents[E]>): void {
    this.emitter.emit(event, ...args)
  }

  listenerCount(event: keyof BotEvents): number {
    return this.emitter.listenerCount(event)
  }
}
