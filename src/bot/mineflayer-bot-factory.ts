import mineflayer from 'mineflayer'
import type { ConnectTarget } from '../core/connection.port.js'
import type { BotFactory, BotLike } from './bot-like.types.js'

type EventMethods = 'on' | 'once' | 'removeListener'

/** The only place that creates a real Mineflayer bot. */
export const createMineflayerBot: BotFactory = (target: ConnectTarget): BotLike => {
  const bot = mineflayer.createBot({
    host: target.host,
    port: target.port,
    username: target.username,
    version: target.version,
    auth: target.auth,
  })
  // Compile-time guard: every member except the event methods must match exactly.
  const _members: Omit<BotLike, EventMethods> = bot
  // The event methods are generic over Mineflayer's much larger event map, which TypeScript cannot
  // relate to our narrow one. At runtime they behave identically for the events we subscribe to.
  return bot as unknown as BotLike
}
