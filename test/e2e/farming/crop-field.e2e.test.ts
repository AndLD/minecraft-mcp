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
          (b) =>
            b.position.x === position.x &&
            b.position.y === position.y &&
            b.position.z === position.z,
        )
        return seen ? true : undefined
      },
      {
        description: `the bot to see ${name} at ${String(position.x)}, ${String(position.y)}, ${String(position.z)}`,
      },
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
    await world.give(bot(), 'water_bucket', 3)
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
    // The water trench is the whole centre column, x0 + 1.
    for (const dz of [0, 1, 2])
      expect(await is({ x: origin.x + 1, y: origin.y, z: origin.z + dz }, 'water')).toBe(true)
    // The fence ring is one cell outside the 3x3 footprint on every side.
    expect(await is({ x: origin.x - 1, y: origin.y + 1, z: origin.z }, 'oak_fence')).toBe(true)
    expect(await is({ x: origin.x + 3, y: origin.y + 1, z: origin.z }, 'oak_fence')).toBe(true)

    const list = dataOf<{ farms: { label: string; crop: string }[] }>(
      await session.bot.call('list_farms'),
    )
    expect(list.farms).toContainEqual(
      expect.objectContaining({ label: 'wheat field', crop: 'wheat' }),
    )
  })

  /** Every farmland cell of the field reads back as fully moist (the game only moistens on random ticks: speed them up). */
  async function untilAllMoist(from: Position, width: number, length: number): Promise<void> {
    await world.setGameRule('randomTickSpeed', 300)
    let dry = 'none'
    try {
      await waitUntil(
        async () => {
          for (let i = 0; i < width; i += 1)
            for (let j = 0; j < length; j += 1) {
              const plot = { x: from.x + i, y: from.y, z: from.z + j }
              if (await is(plot, 'water')) continue
              if (!(await is(plot, 'farmland[moisture=7]'))) {
                dry = `${String(i)},${String(j)}`
                return undefined
              }
            }
          return true
        },
        { timeoutMs: 60_000, description: 'every farmland cell to be moist' },
      )
    } catch (error) {
      // A picture of the field (W water, M moist farmland, F drier farmland, D dirt, G grass), for the failure message.
      const rows: string[] = []
      for (let j = 0; j < length; j += 1) {
        let row = ''
        for (let i = 0; i < width; i += 1) {
          const plot = { x: from.x + i, y: from.y, z: from.z + j }
          if (await is(plot, 'water')) row += 'W'
          else if (await is(plot, 'farmland[moisture=7]')) row += 'M'
          else if (await is(plot, 'farmland')) row += 'F'
          else if (await is(plot, 'dirt')) row += 'D'
          else if (await is(plot, 'grass_block')) row += 'G'
          else row += '?'
        }
        rows.push(row)
      }
      throw new Error(`${String(error)}; last dry plot ${dry}:\n${rows.join('\n')}`, {
        cause: error,
      })
    } finally {
      await world.setGameRule('randomTickSpeed', 3)
    }
  }

  it('waters a whole 7x7 field from one block at its centre, and the gate lies along the fence', async () => {
    await world.give(bot(), 'wooden_hoe', 1)
    await world.give(bot(), 'wheat_seeds', 50)
    await world.give(bot(), 'water_bucket', 1)
    await world.give(bot(), 'oak_fence', 40)
    await world.give(bot(), 'oak_fence_gate', 1)
    await untilBotCarries('wooden_hoe')
    const origin = cell(2, -1, -12)

    const built = await run('build_farm', {
      kind: 'field',
      params: { width: 7, length: 7, crop: 'wheat', fence: true, torches: false, water: 'spots' },
      origin,
      label: 'big field',
    })

    if (built.failed) throw new Error(`build_farm did not succeed: ${built.text}`)
    // One water block, at the middle of the field, and none anywhere else.
    expect(await is({ x: origin.x + 3, y: origin.y, z: origin.z + 3 }, 'water')).toBe(true)
    let water = 0
    for (let i = 0; i < 7; i += 1)
      for (let j = 0; j < 7; j += 1)
        if (await is({ x: origin.x + i, y: origin.y, z: origin.z + j }, 'water')) water += 1
    expect(water).toBe(1)
    await untilAllMoist(origin, 7, 7)
    // The gate is in the south side (z = z0 + 7), which runs along x: it faces north or south, never east or west.
    const gate = { x: origin.x + 3, y: origin.y + 1, z: origin.z + 7 }
    expect(await is(gate, 'oak_fence_gate')).toBe(true)
    const facesAlong =
      (await is(gate, 'oak_fence_gate[facing=north]')) ||
      (await is(gate, 'oak_fence_gate[facing=south]'))
    expect(facesAlong).toBe(true)
  }, 240_000)

  it('waters the far end of a long field too', async () => {
    await world.give(bot(), 'diamond_hoe', 1) // a wooden hoe lasts only 59 uses
    await world.give(bot(), 'wheat_seeds', 64)
    await world.give(bot(), 'water_bucket', 2) // a 12-long field has two 6-long parts
    await untilBotCarries('diamond_hoe')
    const origin = cell(-12, -1, -14)

    const built = await run('build_farm', {
      kind: 'field',
      params: { width: 3, length: 12, crop: 'wheat', fence: false, torches: false, water: 'spots' },
      origin,
      label: 'long field',
    })

    if (built.failed) throw new Error(`build_farm did not succeed: ${built.text}`)
    await untilAllMoist(origin, 3, 12)
  }, 240_000)

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
    expect(before.components).toMatchObject([
      { ripe: 1, growing: 1, empty: 0, kind: 'field', crop: 'wheat' },
    ])

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
    // Water at the level of the plots keeps them farmland. Dry farmland with no crop on it turns back into dirt on a
    // random tick, which made this test fail now and then (the bot has no hoe here, so it could not till it again).
    await world.setBlock(cell(4, 0, -10), 'water')
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
  it('builds the gate on the east side, in line with the fence', async () => {
    await world.give(bot(), 'wooden_hoe', 1)
    await world.give(bot(), 'wheat_seeds', 10)
    await world.give(bot(), 'water_bucket', 1)
    await world.give(bot(), 'oak_fence', 20)
    await world.give(bot(), 'oak_fence_gate', 1)
    await untilBotCarries('wooden_hoe')
    const origin = cell(2, -1, -10)

    const built = await run('build_farm', {
      kind: 'field',
      params: {
        width: 3,
        length: 3,
        crop: 'wheat',
        fence: true,
        torches: false,
        water: 'spots',
        gate_side: 'east',
      },
      origin,
      label: 'east gate field',
    })

    if (built.failed) throw new Error(`build_farm did not succeed: ${built.text}`)
    // The east side is the line x = x0 + 3, which runs along z: the gate is in the middle of it and faces east or west.
    const gate = { x: origin.x + 3, y: origin.y + 1, z: origin.z + 1 }
    expect(await is(gate, 'oak_fence_gate')).toBe(true)
    const facesAlong =
      (await is(gate, 'oak_fence_gate[facing=east]')) ||
      (await is(gate, 'oak_fence_gate[facing=west]'))
    expect(facesAlong).toBe(true)
    // The south middle stays a plain fence post: the gate really moved.
    expect(await is({ x: origin.x + 1, y: origin.y + 1, z: origin.z + 3 }, 'oak_fence')).toBe(true)
    const list = dataOf<{ farms: { label: string; gateSide: string }[] }>(
      await session.bot.call('list_farms'),
    )
    expect(list.farms).toContainEqual(
      expect.objectContaining({ label: 'east gate field', gateSide: 'east' }),
    )
  }, 240_000)

  it('builds a pumpkin field and harvests a pumpkin without touching the stem', async () => {
    await world.give(bot(), 'wooden_hoe', 1)
    await world.give(bot(), 'pumpkin_seeds', 8)
    await world.give(bot(), 'water_bucket', 3)
    await untilBotCarries('wooden_hoe')
    await untilBotCarries('pumpkin_seeds')
    const origin = cell(2, -1, -10)

    const built = await run('build_farm', {
      kind: 'field',
      params: { width: 3, length: 3, crop: 'pumpkin', fence: false, torches: false },
      origin,
      label: 'pumpkins',
    })

    if (built.failed) throw new Error(`build_farm did not succeed: ${built.text}`)
    // Stems in rows 0 and 2 beside the water column; row 1 stays free.
    for (const dz of [0, 2])
      for (const dx of [0, 2]) {
        const plot = { x: origin.x + dx, y: origin.y, z: origin.z + dz }
        expect(await is(plot, 'farmland')).toBe(true)
        expect(await is({ ...plot, y: plot.y + 1 }, 'pumpkin_stem')).toBe(true)
      }
    for (const dx of [0, 2]) {
      const free = { x: origin.x + dx, y: origin.y, z: origin.z + 1 }
      expect(await is(free, 'farmland')).toBe(false)
      expect(await is({ ...free, y: free.y + 1 }, 'air')).toBe(true)
    }

    // A stem that has grown its fruit: a ripe stem with a pumpkin on the free cell beside it.
    const stem = { x: origin.x, y: origin.y + 1, z: origin.z }
    const fruit = { x: origin.x, y: origin.y + 1, z: origin.z + 1 }
    await world.setBlock(stem, 'pumpkin_stem[age=7]')
    await world.setBlock(fruit, 'pumpkin')
    await untilBotSeesAt('pumpkin', fruit)

    const harvested = await run('harvest_crops', { farm: 'pumpkins' })

    if (harvested.failed) throw new Error(`harvest_crops did not succeed: ${harvested.text}`)
    expect(harvested.task.result).toMatchObject({ harvested: 1, replanted: 0 })
    expect(await is(fruit, 'air')).toBe(true)
    expect(await is(stem, 'pumpkin_stem')).toBe(true)
    for (const dz of [0, 2])
      for (const dx of [0, 2])
        expect(
          await is({ x: origin.x + dx, y: origin.y + 1, z: origin.z + dz }, 'pumpkin_stem'),
        ).toBe(true)
  }, 240_000)

  it('builds a melon field and harvests a melon without touching the stem', async () => {
    await world.give(bot(), 'wooden_hoe', 1)
    await world.give(bot(), 'melon_seeds', 8)
    await world.give(bot(), 'water_bucket', 3)
    await untilBotCarries('wooden_hoe')
    await untilBotCarries('melon_seeds')
    const origin = cell(2, -1, -10)

    const built = await run('build_farm', {
      kind: 'field',
      params: { width: 3, length: 3, crop: 'melon', fence: false, torches: false },
      origin,
      label: 'melons',
    })

    if (built.failed) throw new Error(`build_farm did not succeed: ${built.text}`)
    for (const dz of [0, 2])
      for (const dx of [0, 2]) {
        const plot = { x: origin.x + dx, y: origin.y, z: origin.z + dz }
        expect(await is(plot, 'farmland')).toBe(true)
        expect(await is({ ...plot, y: plot.y + 1 }, 'melon_stem')).toBe(true)
      }

    const stem = { x: origin.x, y: origin.y + 1, z: origin.z }
    const fruit = { x: origin.x, y: origin.y + 1, z: origin.z + 1 }
    await world.setBlock(stem, 'melon_stem[age=7]')
    await world.setBlock(fruit, 'melon')
    await untilBotSeesAt('melon', fruit)

    const harvested = await run('harvest_crops', { farm: 'melons' })

    if (harvested.failed) throw new Error(`harvest_crops did not succeed: ${harvested.text}`)
    expect(harvested.task.result).toMatchObject({ harvested: 1, replanted: 0 })
    expect(await is(fruit, 'air')).toBe(true)
    expect(await is(stem, 'melon_stem')).toBe(true)
  }, 240_000)
})
