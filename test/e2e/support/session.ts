import type { Position } from '../../../src/core/position.types.js'
import { dataOf, startApp, type AppUnderTest } from './app-under-test.js'
import { GROUND_Y, type E2EWorld } from './e2e-world.js'
import { joinAsPlayer, type PlayerBot } from './player-bot.js'
import type { ServerInfo } from './server-config.js'
import { waitUntil } from './wait.js'

/** The middle of the test arena. */
export const ARENA_CENTER: Position = { x: 0.5, y: GROUND_Y, z: 0.5 }

const uniqueName = (prefix: string): string =>
  `${prefix}${String(Math.floor(Math.random() * 100_000))}`

export interface E2ESession {
  readonly world: E2EWorld
  /** The human, played by a second Mineflayer bot. The bot's owner. */
  readonly player: PlayerBot
  /** The app under test (real Mineflayer bot + MCP server). */
  readonly bot: AppUnderTest
  close(): Promise<void>
}

export interface StartSessionOptions {
  /** Connect the bot to the server (default true). */
  readonly connectBot?: boolean
}

/**
 * One test's cast: a clean arena, a player bot (the owner) at one end, and the app under test's bot
 * connected at the other. Names are unique so a lingering server-side session cannot collide.
 */
export async function startSession(
  world: E2EWorld,
  info: ServerInfo,
  options: StartSessionOptions = {},
): Promise<E2ESession> {
  await world.prepareArena(ARENA_CENTER)
  const player = await joinAsPlayer(info, uniqueName('Owner'))
  const bot = await startApp(info, { username: uniqueName('Bot'), owner: player.username })

  if (options.connectBot !== false) {
    const connected = await bot.call('connect')
    if (connected.isError) throw new Error(`The bot could not connect: ${connected.text}`)
    await world.teleport(player.username, { x: 5.5, y: GROUND_Y, z: 5.5 })
    await world.teleport(bot.username, { x: -5.5, y: GROUND_Y, z: -5.5 })
    await world.clearInventory(bot.username)
    // RCON changes reach the bot a moment later: wait until it sees itself at the start and sees its owner.
    await waitUntil(
      async () => {
        const status = dataOf<{ vitals: { position: Position } | null }>(
          await bot.call('get_status'),
        )
        const owner = await bot.call('get_player_position')
        const ownerSeen = !owner.isError && (owner.data as { visible: boolean }).visible
        const here = status.vitals?.position
        return here !== undefined &&
          horizontalDistance(here, { x: -5.5, y: GROUND_Y, z: -5.5 }) < 1 &&
          ownerSeen
          ? true
          : undefined
      },
      { description: 'the bot to arrive at its start position and see its owner' },
    )
  }

  return {
    world,
    player,
    bot,
    async close() {
      await bot.shutdown()
      await player.quit()
      await waitUntil(
        async () => {
          const online = await world.onlinePlayers()
          return !online.includes(bot.username) && !online.includes(player.username)
        },
        { description: 'the players to leave the server' },
      )
    },
  }
}

/** Horizontal distance between two positions, in blocks. */
export const horizontalDistance = (a: Position, b: Position): number =>
  Math.hypot(a.x - b.x, a.z - b.z)
