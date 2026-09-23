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

describe('animal farming on a real Minecraft server', () => {
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

  /** Summoning through RCON reaches the bot's own view a moment later; wait until it actually sees the animal. */
  const untilBotSeesEntity = (name: string): Promise<unknown> =>
    waitUntil(
      async () => {
        const result = await session.bot.call('get_nearby_entities', { radius: 32 })
        if (result.isError) return undefined
        const entities = (result.data as { entities: { name: string }[] }).entities
        return entities.some((entity) => entity.name === name) ? true : undefined
      },
      { description: `the bot to see a ${name}` },
    )

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

  it('builds a fenced pen for one species and registers it', async () => {
    await world.give(bot(), 'oak_fence', 20)
    await world.give(bot(), 'oak_fence_gate', 1)
    await untilBotCarries('oak_fence')
    const origin = cell(2, -1, -10)

    const built = await run('build_farm', {
      kind: 'pen',
      params: { width: 4, length: 4, species: 'cow', water: false, torches: false },
      origin,
      label: 'cow pen',
      herd_target: 6,
    })

    if (built.failed) throw new Error(`build_farm did not succeed: ${built.text}`)
    expect(built.task.result).toMatchObject({ kind: 'cow pen 4x4' })
    expect(await is({ x: origin.x - 1, y: origin.y + 1, z: origin.z }, 'oak_fence')).toBe(true)

    const list = dataOf<{ farms: { label: string; species: string; herdTarget: number }[] }>(
      await session.bot.call('list_farms'),
    )
    expect(list.farms).toContainEqual(
      expect.objectContaining({ label: 'cow pen', species: 'cow', herdTarget: 6 }),
    )
  })

  it('leads a nearby wild cow into a registered pen', async () => {
    const penFrom = cell(10, 0, 0)
    const penTo = cell(13, 0, 3)
    await world.summon('cow', cell(16, 0, 1))
    await world.give(bot(), 'wheat', 5)
    await untilBotCarries('wheat')
    await untilBotSeesEntity('cow')
    const registered = await session.bot.call('register_farm', {
      kind: 'pen',
      species: 'cow',
      from: penFrom,
      to: penTo,
      label: 'cow pen',
    })
    if (registered.isError) throw new Error(`register_farm failed: ${registered.text}`)

    const result = await run('lure_animals', { species: 'cow', count: 1, farm: 'cow pen', max_distance: 24 })

    if (result.failed) throw new Error(`lure_animals did not succeed: ${result.text}`)
    expect(result.task.result).toMatchObject({ led: 1, abandoned: [] })
  })

  it('breeds a fed pair of cows and tend_farm reports the herd at its target', async () => {
    // A generous area (not a tight 4x4 pen): a freshly bred calf wanders a little before the herd is recounted,
    // and a tight boundary right at the parents' feet made this test flaky (found running it against a real server).
    const penFrom = cell(0, 0, -10)
    const penTo = cell(20, 0, 10)
    await world.summon('cow', cell(10, 0, -1))
    await world.summon('cow', cell(11, 0, 0))
    await world.give(bot(), 'wheat', 10)
    await untilBotCarries('wheat')
    await untilBotSeesEntity('cow')
    const registered = await session.bot.call('register_farm', {
      kind: 'pen',
      species: 'cow',
      herd_target: 3,
      from: penFrom,
      to: penTo,
      label: 'cow pen',
    })
    if (registered.isError) throw new Error(`register_farm failed: ${registered.text}`)

    const bred = await run('breed_animals', { species: 'cow', target_count: 3, farm: 'cow pen' })

    if (bred.failed) throw new Error(`breed_animals did not succeed: ${bred.text}`)
    expect(bred.task.result).toMatchObject({ pairsFed: 1, bred: 1, herdSize: 3 })

    const tended = await run('tend_farm', { farm: 'cow pen' })

    if (tended.failed) throw new Error(`tend_farm did not succeed: ${tended.text}`)
    expect(tended.task.result).toMatchObject({
      components: [{ kind: 'pen', herdSizeBefore: 3, herdAction: 'none' }],
    })
  })

  it('collects eggs from a chicken pen, storing a share and throwing the rest back in', async () => {
    const penFrom = cell(0, 0, -10)
    const penTo = cell(10, 0, 0)
    const chestPos = cell(15, 0, 5)
    await world.setBlock(chestPos, 'chest')
    await untilBotSeesBlock('chest')
    const registered = await session.bot.call('register_farm', {
      kind: 'pen',
      species: 'chicken',
      herd_target: 20,
      from: penFrom,
      to: penTo,
      label: 'coop',
    })
    if (registered.isError) throw new Error(`register_farm failed: ${registered.text}`)
    const containerReg = await session.bot.call('register_container', {
      x: chestPos.x,
      y: chestPos.y,
      z: chestPos.z,
      label: 'coop chest',
    })
    if (containerReg.isError) throw new Error(`register_container failed: ${containerReg.text}`)
    await world.summonWith('item', cell(5, 0, -5), '{Item:{id:"minecraft:egg",count:10},PickupDelay:0}')
    await untilBotSeesEntity('item')

    const result = await run('collect_eggs', { farm: 'coop' })

    if (result.failed) throw new Error(`collect_eggs did not succeed: ${result.text}`)
    expect(result.task.result).toMatchObject({ pickedUp: 10, stored: 1, released: 9, penFull: false })
    expect(await world.countInChest(chestPos, 'egg')).toBe(1)
    expect(await world.countItem(bot(), 'egg')).toBe(0)
  })
})
