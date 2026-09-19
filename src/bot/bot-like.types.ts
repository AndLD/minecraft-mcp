import type { ConnectTarget } from '../core/connection.port.js'

export interface BotEvents {
  spawn: () => void
  end: (reason: string) => void
  kicked: (reason: unknown) => void
  error: (error: Error) => void
  chat: (username: string, message: string) => void
  whisper: (username: string, message: string) => void
}

/**
 * The small part of the Mineflayer `Bot` this project uses. The real bot satisfies it
 * structurally; tests use a stub. Nothing outside `src/bot` sees Mineflayer types.
 */
export interface BotLike {
  readonly username: string
  readonly version: string
  readonly health: number
  readonly food: number
  readonly entity:
    | { readonly position: { readonly x: number; readonly y: number; readonly z: number } }
    | undefined
  readonly game: { readonly dimension: string }
  readonly time: { readonly timeOfDay: number }
  chat(message: string): void
  whisper(username: string, message: string): void
  quit(reason?: string): void
  on<E extends keyof BotEvents>(event: E, listener: BotEvents[E]): unknown
  once<E extends keyof BotEvents>(event: E, listener: BotEvents[E]): unknown
  removeListener<E extends keyof BotEvents>(event: E, listener: BotEvents[E]): unknown
}

export type BotFactory = (target: ConnectTarget) => BotLike

/** Tells the chat and vitals adapters which bot is current, and when it changes. */
export interface BotHolder {
  current(): BotLike | undefined
  onChange(listener: (bot: BotLike | undefined) => void): () => void
}
