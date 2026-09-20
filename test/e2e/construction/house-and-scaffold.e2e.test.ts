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

describe('houses, shelters, and pillaring up on a real Minecraft server', () => {
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
        { timeoutMs: 180_000, description: 'the build to finish' },
      )
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  const is = (position: Position, block: string): Promise<boolean> => world.isBlock(position, block)

  it('builds a small house with a door that stands in the doorway', async () => {
    await world.give(bot(), 'oak_planks', 100)
    await world.give(bot(), 'oak_door', 1)
    await untilBotCarries('oak_planks')
    await untilBotCarries('oak_door')
    const origin = cell(2, 0, -12)

    const run = await build({
      blueprint: 'house',
      params: { width: 5, depth: 5 },
      origin: { x: origin.x, y: origin.y, z: origin.z },
    })

    if (run.failed) throw new Error(`The build did not succeed: ${run.text}`)
    // The doorway is at x = 4 in the north wall (z = -12): both halves of the door, and wall above it.
    expect(await is(cell(4, 1, -12), 'oak_door[half=lower]')).toBe(true)
    expect(await is(cell(4, 2, -12), 'oak_door[half=upper]')).toBe(true)
    // The door lies in the plane of the wall (it faces north or south), so it closes the doorway.
    const facing =
      (await is(cell(4, 1, -12), 'oak_door[facing=north]')) ||
      (await is(cell(4, 1, -12), 'oak_door[facing=south]'))
    expect(facing).toBe(true)
    expect(await is(cell(4, 3, -12), 'oak_planks')).toBe(true) // wall above the door
    expect(await is(cell(2, 0, -12), 'oak_planks')).toBe(true) // floor corner
    expect(await is(cell(6, 3, -8), 'oak_planks')).toBe(true) // wall corner
    expect(await is(cell(4, 4, -10), 'oak_planks')).toBe(true) // roof
    expect(await is(cell(4, 1, -10), 'air')).toBe(true) // inside
  })

  it('builds a tall wall by pillaring up, takes the tower down, and stands on the ground again', async () => {
    await world.give(bot(), 'oak_planks', 120) // the walls take 12 x 9 = 108
    await world.give(bot(), 'dirt', 12)
    await untilBotCarries('oak_planks')
    await untilBotCarries('dirt')
    const origin = cell(2, 0, -12)

    const preview = dataOf<{ scaffold: { block: string; height: number } | null }>(
      await session.bot.call('preview_build', {
        blueprint: 'walls',
        params: { width: 4, depth: 4, height: 9, block: 'oak_planks' },
        origin: { x: origin.x, y: origin.y, z: origin.z },
      }),
    )
    expect(preview.scaffold).toMatchObject({ block: 'dirt' })

    const run = await build({
      blueprint: 'walls',
      params: { width: 4, depth: 4, height: 9, block: 'oak_planks' },
      origin: { x: origin.x, y: origin.y, z: origin.z },
    })

    if (run.failed) throw new Error(`The build did not succeed: ${run.text}`)
    expect(await is(cell(2, 8, -12), 'oak_planks')).toBe(true) // the top layer, far above the reach from the ground
    expect(await is(cell(5, 8, -9), 'oak_planks')).toBe(true)
    expect(await is(cell(3, 8, -11), 'air')).toBe(true)
    // No scaffold left: no dirt anywhere around the wall above the ground.
    let stray = 0
    for (let x = -2; x <= 9; x += 1)
      for (let z = -16; z <= -5; z += 1)
        for (let dy = 0; dy <= 12; dy += 1) if (await is(cell(x, dy, z), 'dirt')) stray += 1
    expect(stray).toBe(0)
    // The blocks came back, and the bot is on the ground.
    expect(await world.countItem(bot(), 'dirt')).toBe(12)
    const here = await world.playerPosition(bot())
    expect(here.y).toBeCloseTo(GROUND_Y, 0)
  })

  it('builds an emergency shelter around the bot, and it stays inside', async () => {
    await world.give(bot(), 'cobblestone', 40)
    await untilBotCarries('cobblestone')
    await world.teleport(bot(), { x: 0.5, y: GROUND_Y, z: -10.5 })
    await waitUntil(
      async () => {
        const status = dataOf<{ vitals: { position: Position } | null }>(
          await session.bot.call('get_status'),
        )
        const here = status.vitals?.position
        return here !== undefined && Math.hypot(here.x - 0.5, here.z + 10.5) < 1 ? true : undefined
      },
      { description: 'the bot to arrive' },
    )

    const run = await build({ blueprint: 'shelter' })

    if (run.failed) throw new Error(`The build did not succeed: ${run.text}`)
    expect(run.task.result).toMatchObject({ placed: 32 })
    // The bot's own cell and the one south of it are free; walls surround them, a roof covers them.
    expect(await is(cell(0, 0, -10), 'air')).toBe(true)
    expect(await is(cell(0, 1, -10), 'air')).toBe(true)
    expect(await is(cell(0, 2, -10), 'cobblestone')).toBe(true)
    expect(await is(cell(-1, 0, -10), 'cobblestone')).toBe(true)
    expect(await is(cell(1, 1, -10), 'cobblestone')).toBe(true)
    const here = await world.playerPosition(bot())
    expect(Math.abs(here.x - 0.5)).toBeLessThan(1)
    expect(Math.abs(here.z + 9.5)).toBeLessThan(2.5) // inside the 1x2 room
  })
})
