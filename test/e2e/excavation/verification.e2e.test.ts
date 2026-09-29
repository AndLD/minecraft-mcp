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
  result: { broken: number; placed: number; ended: unknown[] } | null
}

describe('excavation verification on a real Minecraft server', () => {
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
  const is = (position: Position, block: string): Promise<boolean> => world.isBlock(position, block)

  /** Waits until the bot's own view shows a solid floor at the spot again (RCON changes arrive late). */
  const untilBotSeesFloor = (origin: Position): Promise<true> =>
    waitUntil(
      async () => {
        const seen = dataOf<{ blocks: number }>(
          await session.bot.call('preview_excavation', {
            shape: 'pit',
            params: { width: 1, length: 1, depth: 3, exit: 'none' },
            origin: { x: origin.x, y: origin.y, z: origin.z },
          }),
        )
        return seen.blocks === 3 ? true : undefined
      },
      { description: 'the bot to see the solid floor' },
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

  const untilCarries = (item: string): Promise<true> =>
    waitUntil(
      async () => {
        const inventory = await session.bot.call('get_inventory')
        const items = inventory.isError
          ? []
          : (inventory.data as { items: { name: string }[] }).items
        return items.some((entry) => entry.name === item) ? true : undefined
      },
      { description: `the bot to carry ${item}` },
    )

  /** Every cell of a box that does not read as air (a stray block inside a dug volume shows up here). */
  async function nonAir(from: Position, to: Position, except: Position[] = []): Promise<string[]> {
    const found: string[] = []
    for (let x = from.x; x <= to.x; x += 1)
      for (let y = from.y; y <= to.y; y += 1)
        for (let z = from.z; z <= to.z; z += 1) {
          if (except.some((e) => e.x === x && e.y === y && e.z === z)) continue
          if (!(await is({ x, y, z }, 'air'))) found.push(`${String(x)},${String(y)},${String(z)}`)
        }
    return found
  }

  it('leaves no stray block in a quarry whose floor a cavern cuts through', async () => {
    const origin = cell(2, -1, -8)
    await untilBotSeesFloor(origin)
    await world.give(bot(), 'cobblestone', 30)
    await untilCarries('cobblestone')
    // The bottom layer of the footprint (dy -3) and a ring around it are one open cavern.
    await world.fill(cell(0, -3, -10), cell(8, -3, -2), 'air')

    const run = await excavate({
      shape: 'quarry',
      params: { width: 5, length: 5, to_y: origin.y - 2, exit: 'none' },
      origin: { x: origin.x, y: origin.y, z: origin.z },
    })

    if (run.failed) throw new Error(`The dig did not succeed: ${run.text}`)
    expect(await nonAir(cell(2, -1, -8), cell(6, -3, -4))).toEqual([])
  }, 240_000)
  it('leaves a chest a player placed inside the quarry where it is, and no stray block beside it', async () => {
    const origin = cell(2, -1, -8)
    await untilBotSeesFloor(origin)
    await world.give(bot(), 'cobblestone', 40)
    await untilCarries('cobblestone')
    await world.fill(cell(0, -3, -10), cell(8, -3, -2), 'air')
    const chest = cell(4, -2, -6)
    await world.setBlock(chest, 'chest')

    const run = await excavate({
      shape: 'quarry',
      params: { width: 5, length: 5, to_y: origin.y - 2, exit: 'none' },
      origin: { x: origin.x, y: origin.y, z: origin.z },
    })

    if (run.failed) throw new Error(`The dig did not succeed: ${run.text}`)
    expect(await is(chest, 'chest')).toBe(true)
    expect(await nonAir(cell(2, -1, -8), cell(6, -3, -4), [chest])).toEqual([])
  }, 240_000)

  /** A block of stone (9 wide, 14 long, 6 high) with a two-block pocket at its south face, and the bot in it. */
  async function rockWithPocket(): Promise<void> {
    await world.fill(cell(0, 0, -14), cell(8, 5, -1), 'stone')
    await world.fill(cell(4, 0, -1), cell(4, 1, -1), 'air')
    await world.give(bot(), 'iron_pickaxe')
    await untilCarries('iron_pickaxe')
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

  it('stops under a gravel column and names it, then digs through it with falling_blocks: clear', async () => {
    await rockWithPocket()
    await world.setBlock(cell(4, 2, -6), 'gravel')
    await world.setBlock(cell(4, 3, -6), 'gravel')

    const stopped = await excavate({
      shape: 'tunnel',
      params: { direction: 'north', length: 10, torch_spacing: 0 },
    })

    if (stopped.failed) throw new Error(`The dig did not succeed: ${stopped.text}`)
    expect(stopped.task.result?.ended).toMatchObject([
      { reason: 'falling_blocks', cells: [cell(4, 2, -6), cell(4, 3, -6)] },
    ])
    expect(await is(cell(4, 2, -6), 'gravel')).toBe(true)

    const cleared = await excavate({
      shape: 'tunnel',
      params: { direction: 'north', length: 10, torch_spacing: 0 },
      falling_blocks: 'clear',
    })

    if (cleared.failed) throw new Error(`The dig did not succeed: ${cleared.text}`)
    expect(cleared.task.result?.ended).toEqual([])
    expect(await is(cell(4, 3, -6), 'gravel')).toBe(false)
    expect(await is(cell(4, 2, -6), 'gravel')).toBe(false)
    expect(await is(cell(4, 0, -10), 'air')).toBe(true)
  }, 240_000)

  it('digs a route to an iron block set behind rock with dig_to', async () => {
    await rockWithPocket()
    // Straight ahead of the pocket and two blocks up (a route that ran along x first would hug the open south face).
    const iron = cell(4, 2, -8)
    await world.setBlock(iron, 'iron_ore')

    const run = await excavate({
      shape: 'dig_to',
      params: { target: iron, torch_spacing: 0 },
    })

    if (run.failed) throw new Error(`The dig did not succeed: ${run.text}`)
    expect(run.task.result?.ended).toEqual([])
    expect(await is(iron, 'iron_ore')).toBe(false)
    expect(await is(iron, 'air')).toBe(true)
  }, 240_000)
})
