import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { waitUntil } from '../support/wait.js'

const at = (x: number, z: number): Position => ({ x, y: GROUND_Y, z })

interface TaskView {
  status: string
  result: Record<string, unknown> | null
}

describe('hunting on a real Minecraft server', () => {
  let info: ServerInfo
  let world: E2EWorld
  let session: E2ESession
  let sessionOpen = false

  beforeAll(async () => {
    info = readServerInfo()
    world = await E2EWorld.connect(info)
    await world.setDifficulty('peaceful')
    await world.setGameRule('doDaylightCycle', false)
    await world.setGameRule('doMobSpawning', false)
    await world.setTime('day')
  })

  beforeEach(async () => {
    session = await startSession(world, info)
    sessionOpen = true
  })

  afterEach(async () => {
    if (!sessionOpen) return
    sessionOpen = false
    await session.close()
  })

  afterAll(async () => {
    await world.close()
  })

  const bot = (): string => session.bot.username

  /** Waits until the bot's own inventory shows the item: RCON gives reach it a moment later. */
  const untilBotCarries = (item: string): Promise<unknown> =>
    waitUntil(
      async () => {
        const result = await session.bot.call('get_inventory')
        const items = result.isError ? [] : (result.data as { items: { name: string }[] }).items
        return items.some((entry) => entry.name === item) ? true : undefined
      },
      { description: `the bot to carry ${item}` },
    )

  /** Waits until the bot has seen `count` animals (RCON summons reach it a moment later). */
  const untilBotSeesAnimals = (count: number): Promise<unknown> =>
    waitUntil(
      async () => {
        const result = await session.bot.call('list_huntable_animals', { radius: 40 })
        const seen = result.isError ? 0 : (result.data as { animals: unknown[] }).animals.length
        return seen >= count ? true : undefined
      },
      { description: `the bot to see ${String(count)} animals` },
    )

  const summonCows = async (count: number): Promise<void> => {
    for (let i = 0; i < count; i += 1) await world.summon('cow', at(-1 + i * 1.5, -2 + (i % 2)))
  }

  async function runToTheEnd(tool: string, args: Record<string, unknown>) {
    const first = await session.bot.call(tool, { wait_seconds: 25, ...args })
    if (first.isError) return { failed: true, text: first.text, task: undefined }
    let task = first.data as TaskView
    if (task.status === 'running') {
      task = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 100_000, description: `${tool} to finish` },
      )
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  it('hunts raw beef from cows, leaving a named cow, a tamed wolf, and the last breeding pair alone', async () => {
    await summonCows(4)
    await world.summonWith('cow', at(2, 2), '{NoAI:1b,CustomName:\'"Bessie"\'}')
    await world.summonWith('wolf', at(3, 0), '{NoAI:1b,Tame:1b,Owner:[I;1,2,3,4]}')
    await world.give(bot(), 'iron_sword')
    await untilBotCarries('iron_sword')
    await untilBotSeesAnimals(6)

    const hunt = await runToTheEnd('hunt_animals', { item: 'beef', count: 3 })

    if (hunt.failed) throw new Error(`The hunt did not succeed: ${hunt.text}`)
    expect(await world.countItem(bot(), 'beef')).toBeGreaterThanOrEqual(3)
    expect(await world.countEntities('@e[type=cow,name=Bessie]')).toBe(1)
    expect(await world.countEntities('@e[type=wolf]')).toBe(1)
    expect(await world.countEntities('@e[type=cow]')).toBeGreaterThanOrEqual(2) // the herd is never hunted below a pair
  })

  it('keeps the last breeding pair: with two cows nothing is killed', async () => {
    await summonCows(2)
    await world.give(bot(), 'iron_sword')
    await untilBotCarries('iron_sword')
    await untilBotSeesAnimals(2)

    const result = await session.bot.call('hunt_animals', {
      species: ['cow'],
      count: 1,
      wait_seconds: 20,
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('breeding_floor')
    expect(await world.countEntities('@e[type=cow]')).toBe(2)
  })

  it('cooks the meat: a hunt for cooked beef ends with steaks in the inventory', async () => {
    await summonCows(4)
    await world.give(bot(), 'iron_sword')
    await world.give(bot(), 'furnace')
    await world.give(bot(), 'coal')
    await untilBotCarries('iron_sword')
    await untilBotCarries('furnace')
    await untilBotCarries('coal')
    await untilBotSeesAnimals(4)

    const hunt = await runToTheEnd('hunt_animals', { item: 'cooked_beef', count: 2 })

    if (hunt.failed) throw new Error(`The hunt did not succeed: ${hunt.text}`)
    expect(await world.countItem(bot(), 'cooked_beef')).toBeGreaterThanOrEqual(2)
    expect(await world.countItem(bot(), 'beef')).toBe(0)
  })

  it('refuses to attack a tamed wolf unless forced', async () => {
    await world.summonWith('wolf', at(-3, -3), '{NoAI:1b,Tame:1b,Owner:[I;1,2,3,4]}')
    await untilBotSeesAnimals(1)

    const refused = await session.bot.call('attack_entity', { species: 'wolf', wait_seconds: 10 })

    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('protected')
    expect(await world.countEntities('@e[type=wolf]')).toBe(1)
  })

  it('asks what to do when it is hungry with no food and no rule about it', async () => {
    await world.setDifficulty('normal') // on peaceful the food bar refills by itself
    await world.giveEffect(bot(), 'hunger', 60, 100) // drains the food bar within seconds

    const asked = await waitUntil(
      () => {
        const events = session.bot.app.inbox.drain().events
        return events.find((event) => event.type === 'needs_decision')
      },
      { timeoutMs: 40_000, description: 'the bot to ask about food' },
    )
    await world.clearEffects(bot())
    await world.setDifficulty('peaceful')

    expect(asked.message).toContain('set_food_policy')
  })
})
