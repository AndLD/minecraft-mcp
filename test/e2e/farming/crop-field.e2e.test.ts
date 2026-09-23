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

describe('crop farming on a real Minecraft server', () => {
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

  /**
   * RCON changes (setblock) reach the bot's own world view a moment later: wait until it actually sees the block at
   * this exact position before a tool call that reads it (inspect_farm, harvest_crops), or the call can act on a
   * stale view.
   */
  const untilBotSeesAt = (name: string, position: Position): Promise<unknown> =>
    waitUntil(
      async () => {
        const result = await session.bot.call('find_blocks', { names: [name], max_distance: 24 })
        if (result.isError) return undefined
        const blocks = (result.data as { blocks: { position: Position }[] }).blocks
        const seen = blocks.some(
          (b) => b.position.x === position.x && b.position.y === position.y && b.position.z === position.z,
        )
        return seen ? true : undefined
      },
      { description: `the bot to see ${name} at ${String(position.x)}, ${String(position.y)}, ${String(position.z)}` },
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

  it('builds a tilled, watered, fenced field and plants it', async () => {
    await world.give(bot(), 'wooden_hoe', 1)
    await world.give(bot(), 'wheat_seeds', 10)
    await world.give(bot(), 'water_bucket', 2)
    await world.give(bot(), 'oak_fence', 20)
    await world.give(bot(), 'oak_fence_gate', 1)
    await world.give(bot(), 'torch', 5)
    await untilBotCarries('wooden_hoe')
    // The tillable ground is the block AT floor level (one below the walking layer, GROUND_Y).
    const origin = cell(2, -1, -10)

    const built = await run('build_farm', {
      kind: 'field',
      params: { width: 3, length: 3, crop: 'wheat', fence: true, torches: true },
      origin,
      label: 'wheat field',
    })

    if (built.failed) throw new Error(`build_farm did not succeed: ${built.text}`)
    expect(built.task.result).toMatchObject({ kind: 'wheat field 3x3' })
    expect(await is(origin, 'farmland')).toBe(true)
    expect(await is({ ...origin, y: origin.y + 1 }, 'wheat')).toBe(true)
    // The water channel sits at the centre column, x0 + 1.
    expect(await is({ x: origin.x + 1, y: origin.y, z: origin.z }, 'water')).toBe(true)
    // The fence ring is one cell outside the 3x3 footprint on every side.
    expect(await is({ x: origin.x - 1, y: origin.y + 1, z: origin.z }, 'oak_fence')).toBe(true)
    expect(await is({ x: origin.x + 3, y: origin.y + 1, z: origin.z }, 'oak_fence')).toBe(true)

    const list = dataOf<{ farms: { label: string; crop: string }[] }>(
      await session.bot.call('list_farms'),
    )
    expect(list.farms).toContainEqual(expect.objectContaining({ label: 'wheat field', crop: 'wheat' }))
  })

  it('harvests only ripe crops, replants, and inspect_farm reports before and after', async () => {
    const a = cell(2, 0, -10)
    const b = cell(3, 0, -10)
    await world.setBlock(a, 'farmland')
    await world.setBlock({ ...a, y: a.y + 1 }, 'wheat[age=7]')
    await world.setBlock(b, 'farmland')
    await world.setBlock({ ...b, y: b.y + 1 }, 'wheat[age=2]')
    await world.give(bot(), 'wheat_seeds', 5)
    await untilBotCarries('wheat_seeds')
    await untilBotSeesAt('wheat', { ...a, y: a.y + 1 })
    await untilBotSeesAt('wheat', { ...b, y: b.y + 1 })
    const registered = await session.bot.call('register_farm', {
      kind: 'field',
      crop: 'wheat',
      from: a,
      to: b,
      label: 'test field',
    })
    if (registered.isError) throw new Error(`register_farm failed: ${registered.text}`)

    const before = dataOf<{ components: { ripe: number; growing: number }[] }>(
      await session.bot.call('inspect_farm', { farm: 'test field' }),
    )
    expect(before.components).toEqual([{ ripe: 1, growing: 1, empty: 0, id: expect.any(String), kind: 'field', crop: 'wheat' }])

    const harvested = await run('harvest_crops', { farm: 'test field' })

    if (harvested.failed) throw new Error(`harvest_crops did not succeed: ${harvested.text}`)
    expect(harvested.task.result).toMatchObject({ harvested: 1, replanted: 1 })
    expect(await is({ ...a, y: a.y + 1 }, 'wheat[age=0]')).toBe(true) // replanted, fresh
    expect(await is({ ...b, y: b.y + 1 }, 'wheat[age=2]')).toBe(true) // untouched

    const after = dataOf<{ components: { ripe: number; growing: number }[] }>(
      await session.bot.call('inspect_farm', { farm: 'test field' }),
    )
    expect(after.components[0]).toMatchObject({ ripe: 0, growing: 2 })
  })

  it('tend_farm harvests, replants, and plants an empty plot in one pass', async () => {
    const a = cell(2, 0, -10)
    const b = cell(3, 0, -10)
    await world.setBlock(a, 'farmland')
    await world.setBlock({ ...a, y: a.y + 1 }, 'wheat[age=7]')
    await world.setBlock(b, 'farmland') // left empty on purpose
    await world.give(bot(), 'wheat_seeds', 5)
    await untilBotCarries('wheat_seeds')
    await untilBotSeesAt('wheat', { ...a, y: a.y + 1 })
    await untilBotSeesAt('farmland', b)
    const registered = await session.bot.call('register_farm', {
      kind: 'field',
      crop: 'wheat',
      from: a,
      to: b,
      label: 'test field',
    })
    if (registered.isError) throw new Error(`register_farm failed: ${registered.text}`)

    const tended = await run('tend_farm', { farm: 'test field' })

    if (tended.failed) throw new Error(`tend_farm did not succeed: ${tended.text}`)
    expect(tended.task.result).toMatchObject({
      components: [{ kind: 'field', harvested: 1, replanted: 1, planted: 1 }],
    })
    expect(await is({ ...a, y: a.y + 1 }, 'wheat')).toBe(true)
    expect(await is({ ...b, y: b.y + 1 }, 'wheat')).toBe(true)
  })
})
