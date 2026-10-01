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

describe('building on a real Minecraft server', () => {
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

  async function build(args: Record<string, unknown>) {
    const first = await session.bot.call('build', { wait_seconds: 40, ...args })
    if (first.isError) return { failed: true as const, text: first.text, task: undefined }
    let task = first.data as TaskView
    if (task.status === 'running') {
      task = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 120_000, description: 'the build to finish' },
      )
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  const is = (position: Position, block: string): Promise<boolean> => world.isBlock(position, block)

  it('builds a small room with a doorway from supplied blocks, and the layout is right', async () => {
    await world.give(bot(), 'cobblestone', 60)
    await untilBotCarries('cobblestone')
    const origin = cell(2, 0, -10)

    const run = await build({
      blueprint: 'box',
      params: { width: 4, depth: 4, height: 2 },
      origin: { x: origin.x, y: origin.y, z: origin.z },
    })

    if (run.failed) throw new Error(`The build did not succeed: ${run.text}`)
    expect(run.task.result).toMatchObject({ placed: 54, broken: 0 })
    // Floor, walls, roof.
    expect(await is(cell(2, 0, -10), 'cobblestone')).toBe(true) // floor corner
    expect(await is(cell(5, 0, -7), 'cobblestone')).toBe(true) // the opposite floor corner
    expect(await is(cell(5, 2, -7), 'cobblestone')).toBe(true) // wall corner, top layer
    expect(await is(cell(2, 1, -8), 'cobblestone')).toBe(true) // west wall
    expect(await is(cell(3, 3, -9), 'cobblestone')).toBe(true) // roof
    // Hollow inside, and a doorway in the north wall (x = 4, z = -10), two blocks high.
    expect(await is(cell(3, 1, -9), 'air')).toBe(true)
    expect(await is(cell(4, 1, -10), 'air')).toBe(true)
    expect(await is(cell(4, 2, -10), 'air')).toBe(true)
    expect(await is(cell(3, 1, -10), 'cobblestone')).toBe(true) // next to the doorway
    // It used exactly what it needed.
    expect(await world.countItem(bot(), 'cobblestone')).toBe(6)
  })

  it('says exactly what is missing when the inventory is empty, and builds nothing', async () => {
    const origin = cell(2, 0, -10)

    const result = await session.bot.call('build', {
      blueprint: 'box',
      params: { width: 4, depth: 4, height: 2 },
      origin: { x: origin.x, y: origin.y, z: origin.z },
      wait_seconds: 20,
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('missing_materials')
    expect(result.text).toContain('54 cobblestone')
    expect(await is(cell(2, 0, -10), 'air')).toBe(true)
    expect(await is(cell(5, 2, -7), 'air')).toBe(true)
  })

  it('previews a build without touching the world', async () => {
    await world.give(bot(), 'cobblestone', 10)
    await untilBotCarries('cobblestone')
    const origin = cell(2, 0, -10)

    const preview = dataOf<{ toPlace: number; missing: { name: string; count: number }[] }>(
      await session.bot.call('preview_build', {
        blueprint: 'floor',
        params: { width: 5, depth: 5 },
        origin: { x: origin.x, y: origin.y, z: origin.z },
      }),
    )

    expect(preview.toPlace).toBe(25)
    expect(preview.missing).toEqual([{ name: 'cobblestone', count: 15 }])
    expect(await is(cell(2, 0, -10), 'air')).toBe(true)
  })

  it('fetches what it lacks from a chest, then builds', async () => {
    await world.setBlock(cell(-8, 0, 8), 'chest')
    await world.fillSlot(cell(-8, 0, 8), 0, 'cobblestone', 30)
    await world.give(bot(), 'cobblestone', 10)
    await untilBotCarries('cobblestone')
    await waitUntil(
      async () => {
        const seen = await session.bot.call('find_blocks', { names: ['chest'] })
        return !seen.isError && (seen.data as { count: number }).count >= 1 ? true : undefined
      },
      { description: 'the bot to see the chest' },
    )
    const chest = cell(-8, 0, 8)
    dataOf(
      await session.bot.call('register_container', {
        x: chest.x,
        y: chest.y,
        z: chest.z,
        label: 'stone',
      }),
    )
    const origin = cell(2, 0, -13)

    const run = await build({
      blueprint: 'floor',
      params: { width: 5, depth: 5 },
      origin: { x: origin.x, y: origin.y, z: origin.z },
    })

    if (run.failed) throw new Error(`The build did not succeed: ${run.text}`)
    expect(run.task.result).toMatchObject({
      placed: 25,
      fetched: [{ name: 'cobblestone', count: 15 }],
    })
    expect(await is(cell(6, 0, -9), 'cobblestone')).toBe(true)
    expect(await world.countInChest(chest, 'cobblestone')).toBe(15)
  })

  it('refuses to build into a protected area', async () => {
    await world.give(bot(), 'cobblestone', 30)
    await untilBotCarries('cobblestone')
    dataOf(
      await session.bot.call('protect_area', {
        label: 'village',
        x1: 0,
        y1: GROUND_Y - 1,
        z1: -12,
        x2: 8,
        y2: GROUND_Y + 10,
        z2: -6,
      }),
    )
    const origin = cell(2, 0, -10)

    const result = await session.bot.call('build', {
      blueprint: 'floor',
      params: { width: 3, depth: 3 },
      origin: { x: origin.x, y: origin.y, z: origin.z },
      wait_seconds: 20,
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('protected_area')
    expect(await is(cell(2, 0, -10), 'air')).toBe(true)
  })
})
