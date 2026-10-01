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
  result: {
    broken: number
    ended: { branch: string; reason: string; at: Position | undefined; skipped: number }[]
  } | null
}

describe('excavating on a real Minecraft server', () => {
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
    // The arena reset only restores the top layer of the floor: fill the layers below back in after earlier digs.
    await world.fill(cell(-14, -3, -14), cell(14, -2, 14), 'dirt')
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

  async function excavate(args: Record<string, unknown>) {
    const first = await session.bot.call('excavate', { wait_seconds: 40, ...args })
    if (first.isError) return { failed: true as const, text: first.text, task: undefined }
    let task = first.data as TaskView
    if (task.status === 'running') {
      task = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 180_000, description: 'the dig to finish' },
      )
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  const is = (position: Position, block: string): Promise<boolean> => world.isBlock(position, block)

  /**
   * A solid block of stone (9 wide, 14 long, 6 high) with an open two-block pocket at its south face, and the bot in
   * it: a tunnel goes north from the pocket into the rock.
   */
  async function rockWithPocket(): Promise<void> {
    await world.fill(cell(0, 0, -14), cell(8, 5, -1), 'stone')
    await world.fill(cell(4, 0, -1), cell(4, 1, -1), 'air')
    await world.give(bot(), 'iron_pickaxe')
    await untilBotCarries('iron_pickaxe')
    await world.teleport(bot(), { x: 4.5, y: GROUND_Y, z: -0.5 })
    await waitUntil(
      async () => {
        const status = dataOf<{ vitals: { position: Position } | null }>(
          await session.bot.call('get_status'),
        )
        const here = status.vitals?.position
        const seen = await session.bot.call('find_blocks', { names: ['stone'], max_distance: 6 })
        return here !== undefined &&
          Math.hypot(here.x - 4.5, here.z + 0.5) < 1 &&
          !seen.isError &&
          (seen.data as { count: number }).count > 0
          ? true
          : undefined
      },
      { description: 'the bot to be in its pocket and see the rock' },
    )
  }

  it('digs a tunnel with torches and stops one block before lava, which stays where it is', async () => {
    await rockWithPocket()
    await world.setBlock(cell(4, 0, -9), 'lava')
    await world.give(bot(), 'torch', 4)
    await untilBotCarries('torch')

    const run = await excavate({ shape: 'tunnel', params: { direction: 'north', length: 14 } })

    if (run.failed) throw new Error(`The dig did not succeed: ${run.text}`)
    // The origin is the bot's own cell (z = -1); the lava is at z = -9, so the last cell dug is z = -7.
    for (let z = -1; z >= -7; z -= 1) {
      expect(await is(cell(4, 0, z), 'stone')).toBe(false)
      expect(await is(cell(4, 1, z), 'stone')).toBe(false)
    }
    expect(await is(cell(4, 0, -8), 'stone')).toBe(true) // the cell next to the lava is left
    expect(await is(cell(4, 0, -9), 'lava')).toBe(true)
    expect(run.task.result?.ended).toMatchObject([
      { branch: 'main', reason: 'hit_lava', at: cell(4, 0, -9) },
    ])
    expect(await is(cell(4, 0, -6), 'torch')).toBe(true) // the first torch, six blocks in
  })

  it('stops before water beside the way, and mines the ore that touches the tunnel', async () => {
    await rockWithPocket()
    await world.setBlock(cell(5, 1, -6), 'water')
    await world.setBlock(cell(5, 0, -3), 'iron_ore')
    await world.setBlock(cell(6, 0, -3), 'iron_ore')
    await world.give(bot(), 'torch', 4)
    await untilBotCarries('torch')

    const run = await excavate({ shape: 'tunnel', params: { direction: 'north', length: 14 } })

    if (run.failed) throw new Error(`The dig did not succeed: ${run.text}`)
    expect(run.task.result?.ended).toMatchObject([{ branch: 'main', reason: 'hit_water' }])
    expect(await is(cell(5, 1, -6), 'water')).toBe(true) // untouched
    expect(await is(cell(4, 0, -5), 'stone')).toBe(false) // it dug up to just before the water
    expect(await is(cell(5, 0, -3), 'iron_ore')).toBe(false) // the ore beside the tunnel was mined
    expect(await is(cell(6, 0, -3), 'iron_ore')).toBe(false) // and the rest of the vein
    expect(await is(cell(7, 0, -3), 'stone')).toBe(true) // the rock around it stays
  })

  it('digs a branch mine: branches every three blocks with two blocks of rock between them, and torches', async () => {
    await rockWithPocket()
    await world.give(bot(), 'torch', 12)
    await untilBotCarries('torch')

    const run = await excavate({
      shape: 'branch_mine',
      params: { direction: 'north', length: 7, branch_length: 3 },
    })

    if (run.failed) throw new Error(`The dig did not succeed: ${run.text}`)
    expect(run.task.result?.ended).toEqual([])
    // Junctions at z = -4 and z = -7 (three and six blocks from the bot's cell).
    for (const z of [-4, -7]) {
      expect(await is(cell(7, 0, z), 'stone')).toBe(false) // three blocks east
      expect(await is(cell(1, 0, z), 'stone')).toBe(false) // three blocks west
    }
    expect(await is(cell(7, 0, -5), 'stone')).toBe(true) // rock between the branches
    expect(await is(cell(7, 0, -6), 'stone')).toBe(true)
    // Torches: one six blocks in (z = -6); the junction torches would be closer than the spacing to it.
    expect(await is(cell(4, 0, -6), 'torch')).toBe(true)
  })

  it('digs a 3x3x2 pit with a ladder, and the bot climbs out of a deeper one by itself', async () => {
    await world.give(bot(), 'ladder', 8)
    await untilBotCarries('ladder')
    const origin = cell(3, -1, -6) // the grass layer: the top layer of the pit

    const run = await excavate({
      shape: 'pit',
      params: { width: 3, length: 3, depth: 3 },
      origin: { x: origin.x, y: origin.y, z: origin.z },
    })

    if (run.failed) throw new Error(`The dig did not succeed: ${run.text}`)
    expect(run.task.result?.broken).toBe(27)
    expect(await is(cell(4, -1, -5), 'air')).toBe(true) // the middle of the top layer
    expect(await is(cell(4, -3, -5), 'air')).toBe(true) // and of the bottom one
    expect(await is(cell(3, -1, -5), 'ladder')).toBe(true) // the ladder column, west wall, middle row
    expect(await is(cell(3, -3, -5), 'ladder')).toBe(true)
    expect(await is(cell(4, -4, -5), 'bedrock')).toBe(true) // the floor below stays (bedrock at -64)

    // The bot is at the bottom: it can walk out by the ladder.
    const surface = { x: 1.5, y: GROUND_Y, z: -5.5 }
    const out = await session.bot.call('goto', {
      x: surface.x,
      y: surface.y,
      z: surface.z,
      wait_seconds: 30,
    })
    expect(out.isError).toBe(false)
    await waitUntil(
      async () => {
        const here = await world.playerPosition(bot())
        return Math.hypot(here.x - surface.x, here.z - surface.z) < 2 && here.y > GROUND_Y - 0.5
          ? true
          : undefined
      },
      { description: 'the bot to climb out of the pit' },
    )
  })

  it('previews without digging, and refuses a protected area', async () => {
    await world.give(bot(), 'ladder', 2)
    await untilBotCarries('ladder')
    const origin = cell(3, -1, -6)

    type Preview = { blocks: number; interpreted: { exit: string }; missing: unknown[] }
    // Changes made through RCON reach the bot a moment later: ask again until it sees the refilled floor.
    const preview = await waitUntil(
      async () => {
        const seen = dataOf<Preview>(
          await session.bot.call('preview_excavation', {
            shape: 'pit',
            params: { width: 3, length: 3, depth: 3 },
            origin: { x: origin.x, y: origin.y, z: origin.z },
          }),
        )
        return seen.blocks === 27 ? seen : undefined
      },
      { description: 'the bot to see the solid floor again' },
    )
    expect(preview.blocks).toBe(27)
    expect(preview.interpreted.exit).toBe('ladder')
    expect(preview.missing).toEqual([{ name: 'ladder', count: 1 }])
    expect(await is(cell(4, -1, -5), 'grass_block')).toBe(true)

    dataOf(
      await session.bot.call('protect_area', {
        label: 'village',
        x1: 0,
        y1: GROUND_Y - 3,
        z1: -10,
        x2: 8,
        y2: GROUND_Y + 5,
        z2: -2,
      }),
    )
    const refused = await session.bot.call('excavate', {
      shape: 'pit',
      params: { width: 2, length: 2, depth: 1, exit: 'none' },
      origin: { x: origin.x, y: origin.y, z: origin.z },
      wait_seconds: 20,
    })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('protected_area')
    expect(await is(cell(3, -1, -6), 'grass_block')).toBe(true)
  })
})
