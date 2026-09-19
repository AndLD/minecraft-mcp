import mineflayer from 'mineflayer'
import pathfinderPlugin from 'mineflayer-pathfinder'
import type { ConnectTarget } from '../core/connection.port.js'
import type { BotFactory, BotLike } from './bot-like.types.js'
import { formatHashedSeed } from './hashed-seed.js'

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
  bot.loadPlugin(pathfinderPlugin.pathfinder)
  // Mineflayer does not expose the hashed world seed, which identifies the world across sessions.
  bot._client.on(
    'login',
    (packet: { worldState?: { hashedSeed?: unknown }; hashedSeed?: unknown }) => {
      const worldSeed = formatHashedSeed(packet.worldState?.hashedSeed ?? packet.hashedSeed)
      if (worldSeed !== undefined) Object.assign(bot, { worldSeed })
    },
  )
  bot.once('spawn', () => {
    // Safe movement profile: never dig or build to reach a goal (that could break player builds).
    // The pathfinder already avoids lava, fire, and deep drops.
    const movements = new pathfinderPlugin.Movements(bot)
    movements.canDig = false
    movements.allow1by1towers = false
    movements.scafoldingBlocks = []
    bot.pathfinder.setMovements(movements)
  })

  // Compile-time guard: every member except the event methods must match exactly.
  const _members: Omit<BotLike, EventMethods> = bot
  // The event methods are generic over Mineflayer's much larger event map, which TypeScript cannot
  // relate to our narrow one. At runtime they behave identically for the events we subscribe to.
  return bot as unknown as BotLike
}
