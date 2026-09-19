import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { horizontalDistance, startSession, type E2ESession } from '../support/session.js'
import { pause, waitUntil } from '../support/wait.js'

const at = (x: number, z: number): Position => ({ x, y: GROUND_Y, z })
/** Where the session puts the bot: (-5.5, -5.5). The owner stands at (5.5, 5.5). */
const BOT = at(-5.5, -5.5)

describe('survival reflexes on a real Minecraft server', () => {
  let info: ServerInfo
  let world: E2EWorld
  let session: E2ESession
  let sessionOpen = false

  beforeAll(async () => {
    info = readServerInfo()
    world = await E2EWorld.connect(info)
    // Hostile mobs need a difficulty above peaceful, and must not burn up in daylight or spawn on their own.
    await world.setDifficulty('normal')
    await world.setGameRule('doDaylightCycle', false)
    await world.setGameRule('doMobSpawning', false)
    await world.setGameRule('mobGriefing', false)
    await world.setTime('midnight')
  })

  beforeEach(async () => {
    session = await startSession(world, info)
    sessionOpen = true
    // Full health, fed, no leftovers from the previous test.
    await world.clearEffects(session.bot.username)
    await world.command(
      `effect give ${session.bot.username} minecraft:instant_health 1 10 true`,
      true,
    )
  })

  afterEach(async () => {
    if (!sessionOpen) return // the setup failed: there is nothing to close
    sessionOpen = false
    await session.close()
  })

  afterAll(async () => {
    await world.setDifficulty('peaceful')
    await world.setGameRule('mobGriefing', true)
    await world.close()
  })

  const botPosition = (): Promise<Position> => world.playerPosition(session.bot.username)

  /** What the bot's reflexes told the agent so far. */
  const reflexEvents = (): string[] =>
    session.bot.app.inbox
      .drain()
      .events.filter((e) => e.type === 'reflex')
      .map((e) => e.message)

  it('fights a zombie that attacks it, and wins', async () => {
    await world.give(session.bot.username, 'iron_sword', 1)
    await world.give(session.bot.username, 'iron_chestplate', 1)
    await world.summonWith('zombie', at(-1.5, -5.5), '{PersistenceRequired:1b}')

    await waitUntil(async () => !(await world.entityExists('@e[type=zombie]')), {
      timeoutMs: 40_000,
      description: 'the zombie to be killed',
    })

    const events = reflexEvents()
    expect(events.some((m) => m.startsWith('Fighting a zombie'))).toBe(true)
    expect(events.some((m) => m.includes('Put on iron_chestplate') || m.includes('is gone'))).toBe(
      true,
    )
    const health = await world.command(`data get entity ${session.bot.username} Health`)
    expect(Number(/(\d+(\.\d+)?)f/.exec(health)?.[1])).toBeGreaterThan(0)
  })

  it('runs away from a creeper instead of going near it', async () => {
    await world.summonWith('creeper', at(0.5, 0.5), '{NoAI:1b,PersistenceRequired:1b}')

    await waitUntil(async () => horizontalDistance(await botPosition(), at(0.5, 0.5)) > 18, {
      timeoutMs: 30_000,
      description: 'the bot to get away from the creeper',
    })

    expect(reflexEvents()).toEqual(
      expect.arrayContaining([expect.stringContaining('Running away from creeper')]),
    )
    expect(await world.entityExists('@e[type=creeper]')).toBe(true) // it did not attack it
  })

  it('runs away from a skeleton', async () => {
    await world.summonWith('skeleton', at(3.5, -5.5), '{NoAI:1b,PersistenceRequired:1b}')

    await waitUntil(async () => horizontalDistance(await botPosition(), at(3.5, -5.5)) > 22, {
      timeoutMs: 30_000,
      description: 'the bot to get away from the skeleton',
    })

    expect(reflexEvents()).toEqual(
      expect.arrayContaining([expect.stringContaining('Running away from skeleton')]),
    )
  })

  it('leaves an enderman alone, even with a sword in hand', async () => {
    await world.give(session.bot.username, 'iron_sword', 1)
    await world.summonWith('enderman', at(-2.5, -5.5), '{NoAI:1b,PersistenceRequired:1b}')

    await pause(8_000)

    const health = await world.command('data get entity @e[type=enderman,limit=1] Health')
    expect(health).toContain('40') // untouched
    expect(reflexEvents()).toEqual([])
    expect(horizontalDistance(await botPosition(), BOT)).toBeLessThan(3) // it did not go after it either
  })

  it('runs away from a zombie it would normally fight when its health is low', async () => {
    await world.give(session.bot.username, 'iron_sword', 1)
    // A player cannot be hurt for about 3 seconds after joining, so retry until the wound lands: 20 - 14 = 6, below 8.
    await waitUntil(
      async () => {
        await world.damage(session.bot.username, 14)
        const health = await world.command(`data get entity ${session.bot.username} Health`)
        return Number(/(\d+(\.\d+)?)f/.exec(health)?.[1]) < 8 ? true : undefined
      },
      { timeoutMs: 15_000, intervalMs: 500, description: 'the bot to take damage' },
    )
    await world.giveEffect(session.bot.username, 'hunger', 20, 60) // no natural regeneration while it lasts
    const before = await world.command(`data get entity ${session.bot.username} Health`)
    expect(Number(/(\d+(\.\d+)?)f/.exec(before)?.[1])).toBeLessThan(8) // the wound really happened
    await world.summonWith('zombie', at(-1.5, -5.5), '{NoAI:1b,PersistenceRequired:1b}')

    await waitUntil(async () => horizontalDistance(await botPosition(), at(-1.5, -5.5)) > 15, {
      timeoutMs: 30_000,
      description: 'the wounded bot to get away',
    })

    const events = reflexEvents()
    expect(events.some((m) => m.startsWith('Low health'))).toBe(true)
    const zombieHealth = await world.command('data get entity @e[type=zombie,limit=1] Health')
    expect(zombieHealth).toContain('20') // never touched
  })

  it('eats when it gets hungry, and tells the agent', async () => {
    await world.give(session.bot.username, 'bread', 8)
    await world.giveEffect(session.bot.username, 'hunger', 60, 100) // drains the food bar within seconds

    await waitUntil(async () => (await world.countItem(session.bot.username, 'bread')) < 8, {
      timeoutMs: 40_000,
      description: 'the bot to eat some bread',
    })
    await world.clearEffects(session.bot.username)

    expect(reflexEvents().some((m) => m.startsWith('Ate bread'))).toBe(true)
  })

  it('moves away from lava next to it, unhurt', async () => {
    const lava = { x: -5, y: GROUND_Y, z: -6 } // the block next to where the bot stands
    await world.setBlock(lava, 'lava')

    await waitUntil(
      async () => horizontalDistance(await botPosition(), { x: -4.5, y: GROUND_Y, z: -5.5 }) > 3,
      {
        timeoutMs: 20_000,
        description: 'the bot to move away from the lava',
      },
    )

    expect(reflexEvents().some((m) => m.includes('Lava next to me'))).toBe(true)
    const health = await world.command(`data get entity ${session.bot.username} Health`)
    expect(Number(/(\d+(\.\d+)?)f/.exec(health)?.[1])).toBeGreaterThanOrEqual(20)
  })
})
