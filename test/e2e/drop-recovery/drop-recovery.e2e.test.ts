import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { pause, waitUntil } from '../support/wait.js'

const at = (x: number, z: number): Position => ({ x, y: GROUND_Y, z })
/** Where the bot dies. The world's spawn point, where it respawns, is near the middle of the arena. */
const DEATH_SPOT = at(-9.5, 8.5)

interface Recorded {
  id: string
  kind: string
  status: string
  position: Position
  note: string | null
}

describe('recovering dropped items on a real Minecraft server', () => {
  let info: ServerInfo
  let world: E2EWorld
  let session: E2ESession
  let sessionOpen = false
  let heard: { type: string; message: string }[] = []

  beforeAll(async () => {
    info = readServerInfo()
    world = await E2EWorld.connect(info)
    await world.setDifficulty('peaceful')
    await world.setGameRule('doDaylightCycle', false)
    await world.setGameRule('doMobSpawning', false)
    await world.setGameRule('keepInventory', false)
    await world.setTime('day')
  })

  beforeEach(async () => {
    // A short wait before unclaimed items are taken back, so the test does not sit out the default minute.
    session = await startSession(world, info, { appConfig: { unclaimedDropWaitSeconds: 5 } })
    sessionOpen = true
    heard = []
  })

  afterEach(async () => {
    if (!sessionOpen) return
    sessionOpen = false
    await world.setGameRule('keepInventory', false)
    await session.close()
  })

  afterAll(async () => {
    await world.close()
  })

  const bot = (): string => session.bot.username
  const player = (): string => session.player.username

  /** Everything the agent was told so far (reading the inbox empties it, so it is collected here). */
  const events = (): { type: string; message: string }[] => {
    heard.push(...session.bot.app.inbox.drain().events)
    return heard
  }
  const eventOf = (type: string, text?: string) =>
    events().find((e) => e.type === type && (text === undefined || e.message.includes(text)))

  const untilBotCarries = (item: string): Promise<unknown> =>
    waitUntil(
      async () => {
        const result = await session.bot.call('get_inventory')
        const items = result.isError ? [] : (result.data as { items: { name: string }[] }).items
        return items.some((entry) => entry.name === item) ? true : undefined
      },
      { description: `the bot to carry ${item}` },
    )

  const untilBotHas = (item: string, count: number, timeoutMs = 90_000): Promise<number> =>
    waitUntil(
      async () => {
        const have = await world.countItem(bot(), item)
        return have >= count ? have : undefined
      },
      { timeoutMs, description: `the bot to hold ${String(count)} ${item}` },
    )

  const records = async (): Promise<Recorded[]> =>
    dataOf<{ records: Recorded[] }>(await session.bot.call('list_death_records')).records

  /** The bot carries valuables at the spot where it will die. */
  async function loadUpAt(spot: Position): Promise<void> {
    await world.give(bot(), 'iron_ingot', 20)
    await world.give(bot(), 'cobblestone', 64)
    await world.give(bot(), 'iron_pickaxe')
    await untilBotCarries('iron_ingot')
    await untilBotCarries('cobblestone')
    await untilBotCarries('iron_pickaxe')
    await world.teleport(bot(), spot)
    await waitUntil(
      async () => {
        const status = dataOf<{ vitals: { position: Position } | null }>(
          await session.bot.call('get_status'),
        )
        const here = status.vitals?.position
        return here !== undefined && Math.hypot(here.x - spot.x, here.z - spot.z) < 1
          ? true
          : undefined
      },
      { description: 'the bot to arrive at the place it will die' },
    )
  }

  const kill = (): Promise<string> => world.command(`kill ${bot()}`)

  it('dies with its things, says where, walks back by itself, and picks everything up', async () => {
    await loadUpAt(DEATH_SPOT)

    await kill()
    const died = await waitUntil(() => eventOf('bot_died'), {
      timeoutMs: 20_000,
      description: 'the death to be reported',
    })
    expect(died.message).toContain('-9, -60, 9') // where it died (rounded)
    expect(await world.countItem(bot(), 'iron_ingot')).toBe(0) // it really lost everything

    await untilBotHas('iron_ingot', 20)
    await untilBotHas('cobblestone', 64)
    await untilBotHas('iron_pickaxe', 1)

    const done = await waitUntil(() => eventOf('drop_recovery', 'Recovered'), {
      timeoutMs: 30_000,
      description: 'the recovery to be reported',
    })
    expect(done.message).toContain('(recovered)')
    expect(await records()).toMatchObject([{ kind: 'death', status: 'recovered' }])
  })

  it('does nothing about a death when the inventory is kept (keepInventory)', async () => {
    await world.setGameRule('keepInventory', true)
    await loadUpAt(DEATH_SPOT)

    await kill()
    const died = await waitUntil(() => eventOf('bot_died'), {
      timeoutMs: 20_000,
      description: 'the death to be reported',
    })

    expect(died.message).toContain('kept its inventory')
    expect(await world.countItem(bot(), 'iron_ingot')).toBe(20)
    expect(await records()).toEqual([])
  })

  it('leaves the items and gives the coordinates when the policy is skip, and fetches them on request', async () => {
    dataOf(await session.bot.call('set_drop_recovery_policy', { policy: 'skip' }))
    await loadUpAt(DEATH_SPOT)

    await kill()
    const died = await waitUntil(() => eventOf('bot_died'), {
      timeoutMs: 20_000,
      description: 'the death to be reported',
    })
    expect(died.message).toContain('policy skip')
    expect(died.message).toContain('-9, -60, 9')
    await pause(12_000) // long enough for an automatic recovery, had there been one
    expect(await world.countItem(bot(), 'iron_ingot')).toBe(0)
    expect(await records()).toMatchObject([{ status: 'abandoned' }])

    const fetched = dataOf<{ status: string; result: { status: string } | null }>(
      await session.bot.call('recover_drops', { wait_seconds: 55 }),
    )
    expect(fetched.status).toBe('succeeded')
    await untilBotHas('iron_ingot', 20)
  })

  it('asks instead of going to a spot with lava next to it, and can be told to leave it', async () => {
    // A source in a one-block hole in the floor stays where it is. It lies two blocks from where the bot will die.
    await world.setBlock({ x: -8, y: GROUND_Y - 1, z: 8 }, 'lava')
    await waitUntil(
      async () => {
        const seen = await session.bot.call('find_blocks', { names: ['lava'], max_distance: 40 })
        return !seen.isError && (seen.data as { count: number }).count >= 1 ? true : undefined
      },
      { description: 'the bot to see the lava' },
    )
    await loadUpAt(DEATH_SPOT)

    await kill()
    await waitUntil(() => eventOf('bot_died'), { timeoutMs: 20_000, description: 'the death' })
    const question = await waitUntil(() => eventOf('needs_decision', 'dangerous'), {
      timeoutMs: 60_000,
      description: 'the bot to ask about the dangerous spot',
    })
    expect(question.message).toContain('lava')

    // It waits for an answer and did not go in, nor die again.
    const status = dataOf<{ task: { status: string; waitingFor: { options: string[] } | null } }>(
      await session.bot.call('get_task_status'),
    )
    expect(status.task.status).toBe('waiting_for_input')
    expect(status.task.waitingFor?.options).toEqual(['try_carefully', 'abandon'])
    expect(await world.countItem(bot(), 'iron_ingot')).toBe(0)

    const skipped = dataOf<{ skipped: Recorded[] }>(await session.bot.call('skip_drop_recovery'))
    expect(skipped.skipped).toMatchObject([{ status: 'abandoned', position: { x: -9.5 } }])
    expect(events().filter((e) => e.type === 'bot_died')).toHaveLength(1)
    const health = await world.command(`data get entity ${bot()} Health`)
    expect(Number(/(\d+(\.\d+)?)f/.exec(health)?.[1])).toBeGreaterThan(0)
  })

  describe('items thrown for the player that nobody picks up', () => {
    /** A spectator cannot pick anything up, so what the bot throws at their feet stays there. */
    async function ownerCannotPickUp(): Promise<void> {
      await world.command(`gamemode spectator ${player()}`)
      await world.give(bot(), 'iron_ingot', 20)
      await untilBotCarries('iron_ingot')
    }

    const untilOnGround = (): Promise<true> =>
      waitUntil(async () => ((await world.countEntities('@e[type=item]')) > 0 ? true : undefined), {
        description: 'the thrown items to lie on the ground',
      })

    async function give(extra: Record<string, unknown> = {}): Promise<void> {
      const result = dataOf<{ status: string }>(
        await session.bot.call('give_items', {
          items: [{ item: 'iron_ingot', count: 20 }],
          wait_seconds: 55,
          ...extra,
        }),
      )
      expect(result.status).toBe('succeeded')
    }

    it('takes them back after the wait, and says so', async () => {
      await ownerCannotPickUp()

      await give()
      expect(await world.countItem(bot(), 'iron_ingot')).toBe(0)

      await untilBotHas('iron_ingot', 20, 60_000)
      const done = await waitUntil(() => eventOf('drop_recovery', 'Recovered'), {
        timeoutMs: 30_000,
        description: 'the recovery to be reported',
      })
      expect(done.message).toContain('20 iron_ingot')
      expect(await records()).toMatchObject([{ kind: 'unclaimed', status: 'recovered' }])
    })

    it('leaves them where they lie when told not to, and keeps the coordinates', async () => {
      await ownerCannotPickUp()

      await give({ recollect_unclaimed: false })
      await untilOnGround()
      await pause(15_000) // well past the wait

      expect(await world.countItem(bot(), 'iron_ingot')).toBe(0)
      expect(await world.countEntities('@e[type=item]')).toBeGreaterThan(0)
      const noted = eventOf('drop_recovery', 'leaves them there')
      expect(noted).toBeDefined()
      expect(await records()).toMatchObject([
        { kind: 'unclaimed', status: 'abandoned', note: 'Left on the ground on purpose.' },
      ])
    })
  })
})
