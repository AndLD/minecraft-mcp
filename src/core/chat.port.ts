import type { Result } from './result.js'
import type { Unsubscribe } from './connection.port.js'

export interface IncomingChat {
  readonly sender: string
  readonly text: string
  /** True when the message was sent privately to the bot. */
  readonly whisper: boolean
}

export interface ChatPort {
  /** Sends one chat line (the caller keeps it within the game's length limit). */
  say(text: string): Result<void>
  whisper(player: string, text: string): Result<void>
  /** Messages from other players. The bot's own messages are never reported. */
  onMessage(listener: (message: IncomingChat) => void): Unsubscribe
}
