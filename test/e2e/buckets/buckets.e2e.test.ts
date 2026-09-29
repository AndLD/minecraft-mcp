import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { waitUntil } from '../support/wait.js'

/** The grass layer of the arena: a pool dug into it lies level with the ground. */
const SURFACE_Y = GROUND_Y - 1
const cell = (x: number, z: number, y = SURFACE_Y): Position => ({ x, y, z })

interface TaskView {
  status: string
  result: Record<string, unknown> | null
}

describe('filling buckets on a real Minecraft server', () => {
  let info: ServerInfo
  let world: E2EWorld
  let session: E2ESession
  let sessionOpen = false

  beforeAll(async () => {
    info = readServerInfo()
    world = await E2EWorld.connect(info)
    await world.setDifficulty('peaceful')
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

  async function untilBotCarries(item: string): Promise<void> {
    await waitUntil(
      async () => {
        const inventory = await session.bot.call('get_inventory')
        const items = inventory.isError
          ? []
          : (inventory.data as { items: { name: string }[] }).items
        return items.some((stack) => stack.name === item) ? true : undefined
      },
      { description: `the bot to carry ${item}` },
    )
  }

  async function untilBotSees(names: string[], count: number): Promise<void> {
    await waitUntil(
      async () => {
        const found = await session.bot.call('find_blocks', { names, count: 30 })
        return !found.isError && (found.data as { blocks: unknown[] }).blocks.length >= count
          ? true
          : undefined
      },
      { description: `the bot to see ${names.join(', ')}` },
    )
  }

  /** What the bot carries of an item, as its own inventory tool reports it. */
  async function carried(item: string): Promise<number> {
    const inventory = dataOf<{ items: { name: string; count: number }[] }>(
      await session.bot.call('get_inventory'),
    )
    return inventory.items.find((stack) => stack.name === item)?.count ?? 0
  }

  /** Runs a task tool and waits for its end; `failed` carries the failure text. */
  async function run(tool: string, args: Record<string, unknown> = {}) {
    const first = await session.bot.call(tool, { wait_seconds: 50, ...args })
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

  /** A 3x3 pool of source blocks, level with the ground, and the bot with an empty bucket. */
  async function withPool(liquid: 'water' | 'lava', corner: Position): Promise<void> {
    await world.fill(corner, cell(corner.x + 2, corner.z + 2), liquid)
    await world.give(bot(), 'bucket', 1)
    await untilBotCarries('bucket')
    await untilBotSees([liquid], 9)
  }

  it('fills a bucket from a pond and the pond stays (exit criterion)', async () => {
    await withPool('water', cell(8, -8))

    const result = await run('fill_bucket', { liquid: 'water' })

    if (result.failed) throw new Error(result.text)
    expect(result.task.result).toMatchObject({ item: 'water_bucket', filled: 1, poolRefills: true })
    await untilBotCarries('water_bucket')
    expect(await carried('bucket')).toBe(0)
    // The taken block is made again by the two sources beside it a moment later.
    await waitUntil(
      async () => {
        for (let x = 8; x <= 10; x += 1)
          for (let z = -8; z <= -6; z += 1)
            if (!(await world.isBlock(cell(x, z), 'water[level=0]'))) return undefined
        return true
      },
      { description: 'the pond to be whole again' },
    )
  })

  it('takes nothing from flowing water', async () => {
    await world.give(bot(), 'bucket', 1)
    await untilBotCarries('bucket')
    // A source lying on the ground spreads into flowing cells around it.
    await world.setBlock(cell(9, -8, GROUND_Y), 'water')
    await waitUntil(
      async () =>
        (await world.isBlock(cell(10, -8, GROUND_Y), 'water[level=1]')) ? true : undefined,
      {
        description: 'the water to flow',
      },
    )
    await untilBotSees(['water'], 3)

    const flowing = await run('fill_bucket', { liquid: 'water', at: cell(10, -8, GROUND_Y) })

    expect(flowing.failed).toBe(true)
    expect(flowing.text).toContain('not_a_source')
    expect(await carried('bucket')).toBe(1)

    // Without a named block, the search skips the flowing cells and finds the one source.
    const nearest = await run('fill_bucket', { liquid: 'water' })
    if (nearest.failed) throw new Error(nearest.text)
    expect(nearest.task.result).toMatchObject({ from: [cell(9, -8, GROUND_Y)] })
    await untilBotCarries('water_bucket')
  })

  it('fills a bucket from a lava pool without standing where the lava could reach it', async () => {
    await withPool('lava', cell(8, -8))

    const result = await run('fill_bucket', { liquid: 'lava' })

    if (result.failed) throw new Error(result.text)
    expect(result.task.result).toMatchObject({ item: 'lava_bucket', filled: 1 })
    await untilBotCarries('lava_bucket')
    const status = dataOf<{ vitals: { position: Position; health: number } }>(
      await session.bot.call('get_status'),
    )
    // Not one block of lava beside the bot, and it is unhurt.
    const here = {
      x: Math.floor(status.vitals.position.x),
      z: Math.floor(status.vitals.position.z),
    }
    for (let dx = -1; dx <= 1; dx += 1)
      for (let dz = -1; dz <= 1; dz += 1)
        expect(await world.isBlock(cell(here.x + dx, here.z + dz, GROUND_Y), 'lava')).toBe(false)
    expect(status.vitals.health).toBe(20)
    // Exactly one of the nine source blocks is gone.
    let lava = 0
    for (let x = 8; x <= 10; x += 1)
      for (let z = -8; z <= -6; z += 1) if (await world.isBlock(cell(x, z), 'lava')) lava += 1
    expect(lava).toBe(8)
  })

  it('refuses lava beside a block the owner placed, and takes it when the block is named', async () => {
    await withPool('lava', cell(8, -8))
    await world.setBlock(cell(9, -4, GROUND_Y), 'oak_planks')
    await untilBotSees(['oak_planks'], 1)

    const refused = await run('fill_bucket', { liquid: 'lava' })

    expect(refused.failed).toBe(true)
    expect(refused.text).toContain('structure_nearby')
    expect(await carried('lava_bucket')).toBe(0)

    const named = await run('fill_bucket', { liquid: 'lava', at: cell(8, -8) })
    if (named.failed) throw new Error(named.text)
    await untilBotCarries('lava_bucket')
  })

  it('refuses lava inside a protected area', async () => {
    await withPool('lava', cell(8, -8))
    dataOf(
      await session.bot.call('protect_area', {
        label: 'Lava room',
        x1: 6,
        y1: SURFACE_Y - 2,
        z1: -10,
        x2: 12,
        y2: GROUND_Y + 4,
        z2: -4,
      }),
    )

    const result = await run('fill_bucket', { liquid: 'lava' })

    expect(result.failed).toBe(true)
    expect(result.text).toContain('protected_area')
    expect(await carried('lava_bucket')).toBe(0)
  })

  it('says what to craft when it has no empty bucket', async () => {
    await world.fill(cell(8, -8), cell(10, -6), 'water')
    await untilBotSees(['water'], 9)

    const result = await run('fill_bucket', { liquid: 'water' })

    expect(result.failed).toBe(true)
    expect(result.text).toContain('no_bucket')
    expect(result.text).toContain('3 iron ingots')
  })
})
