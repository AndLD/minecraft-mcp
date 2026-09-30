import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { waitUntil } from '../support/wait.js'

const cell = (x: number, dy: number, z: number): Position => ({ x, y: GROUND_Y + dy, z })

interface TaskView {
  status: string
  result: Record<string, unknown> | null
}

describe('honey farming on a real Minecraft server', () => {
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

  const untilBotCarries = (item: string): Promise<unknown> =>
    waitUntil(
      async () => {
        const result = await session.bot.call('get_inventory')
        const items = result.isError ? [] : (result.data as { items: { name: string }[] }).items
        return items.some((entry) => entry.name === item) ? true : undefined
      },
      { description: `the bot to carry ${item}` },
    )

  const untilBotSeesBlock = (name: string): Promise<unknown> =>
    waitUntil(
      async () => {
        const result = await session.bot.call('find_blocks', { names: [name] })
        return !result.isError && (result.data as { count: number }).count >= 1 ? true : undefined
      },
      { description: `the bot to see a ${name}` },
    )

  async function run(tool: string, args: Record<string, unknown>) {
    const first = await session.bot.call(tool, { wait_seconds: 45, ...args })
    if (first.isError) return { failed: true as const, text: first.text, task: undefined }
    let task = first.data as TaskView
    if (task.status === 'running') {
      task = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 120_000, description: `${tool} to finish` },
      )
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  const is = (position: Position, block: string): Promise<boolean> => world.isBlock(position, block)

  it('harvests honey from a ripe hive with a campfire under it, without angering the bees', async () => {
    const campfire = cell(4, 0, -6)
    const hive = cell(4, 1, -6)
    await world.setBlock(campfire, 'campfire[lit=true]')
    await world.setBlock(hive, 'beehive[honey_level=5]')
    await world.summonWith('bee', cell(5, 1, -6), '{NoAI:1b}')
    await world.give(bot(), 'glass_bottle', 2)
    await untilBotCarries('glass_bottle')
    await untilBotSeesBlock('beehive')

    const seen = await session.bot.call('inspect_hives', {})
    if (seen.isError) throw new Error(`inspect_hives failed: ${seen.text}`)
    expect(seen.data).toMatchObject({
      ready: 1,
      hives: [{ honeyLevel: 5, ready: true, smoked: true }],
    })

    const harvested = await run('harvest_honey', {})

    if (harvested.failed) throw new Error(`harvest_honey did not succeed: ${harvested.text}`)
    expect(harvested.task.result).toMatchObject({ honeyBottles: 1, hives: 1, campfiresPlaced: [] })
    await untilBotCarries('honey_bottle')
    expect(await is(hive, 'beehive[honey_level=0]')).toBe(true)
  }, 240_000)

  it('places a campfire under a hive that has none, then harvests', async () => {
    const hive = cell(4, 2, -6)
    await world.setBlock(hive, 'beehive[honey_level=5]')
    await world.give(bot(), 'glass_bottle', 1)
    await world.give(bot(), 'campfire', 1)
    await untilBotCarries('glass_bottle')
    await untilBotCarries('campfire')
    await untilBotSeesBlock('beehive')

    const harvested = await run('harvest_honey', {})

    if (harvested.failed) throw new Error(`harvest_honey did not succeed: ${harvested.text}`)
    expect(harvested.task.result).toMatchObject({ honeyBottles: 1 })
    expect((harvested.task.result as { campfiresPlaced: unknown[] }).campfiresPlaced).toHaveLength(
      1,
    )
    await untilBotCarries('honey_bottle')
    expect(await is(hive, 'beehive[honey_level=0]')).toBe(true)
  }, 240_000)

  it('refuses a hive with no smoke and no campfire, leaving the honey and the bees calm', async () => {
    const hive = cell(4, 2, -6)
    await world.setBlock(hive, 'beehive[honey_level=5]')
    await world.summonWith('bee', cell(5, 2, -6), '{NoAI:1b}')
    await world.give(bot(), 'glass_bottle', 1)
    await untilBotCarries('glass_bottle')
    await untilBotSeesBlock('beehive')

    const refused = await run('harvest_honey', {})

    expect(refused.failed).toBe(true)
    expect(refused.text).toContain('no_smoke')
    expect(await is(hive, 'beehive[honey_level=5]')).toBe(true)
    expect(await world.entityExists('@e[type=bee,nbt={AngerTime:0}]')).toBe(true)
  }, 240_000)

  it('builds an apiary: hives on campfires with a row of flowers, registered and protected', async () => {
    await world.give(bot(), 'beehive', 2)
    await world.give(bot(), 'campfire', 2)
    await world.give(bot(), 'poppy', 8)
    await untilBotCarries('beehive')
    await untilBotCarries('campfire')
    await untilBotCarries('poppy')
    const origin = cell(2, -1, -10)

    const built = await run('build_farm', {
      kind: 'apiary',
      params: { hives: 2 },
      origin,
      label: 'bee yard',
    })

    if (built.failed) throw new Error(`build_farm did not succeed: ${built.text}`)
    for (const dx of [0, 3]) {
      expect(
        await is({ x: origin.x + dx, y: origin.y + 1, z: origin.z }, 'campfire[lit=true]'),
      ).toBe(true)
      expect(await is({ x: origin.x + dx, y: origin.y + 2, z: origin.z }, 'beehive')).toBe(true)
    }
    const list = dataOf<{ farms: { kind: string; species: string | null }[] }>(
      await session.bot.call('list_farms'),
    )
    expect(list.farms).toContainEqual(expect.objectContaining({ kind: 'apiary', species: 'bee' }))
  }, 240_000)

  it('tend_farm takes the honey of an apiary it was pointed at', async () => {
    const campfire = cell(4, 0, -6)
    const hive = cell(4, 1, -6)
    await world.setBlock(campfire, 'campfire[lit=true]')
    await world.setBlock(hive, 'beehive[honey_level=5]')
    await world.give(bot(), 'glass_bottle', 1)
    await untilBotCarries('glass_bottle')
    await untilBotSeesBlock('beehive')
    const registered = await session.bot.call('register_farm', {
      kind: 'apiary',
      species: 'bee',
      from: cell(3, 0, -7),
      to: cell(6, 2, -5),
      label: 'bees',
    })
    if (registered.isError) throw new Error(`register_farm failed: ${registered.text}`)

    const tended = await run('tend_farm', { farm: 'bees' })

    if (tended.failed) throw new Error(`tend_farm did not succeed: ${tended.text}`)
    expect(tended.task.result).toMatchObject({ components: [{ kind: 'apiary', honeyBottles: 1 }] })
  }, 240_000)
})
