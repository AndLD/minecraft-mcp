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
  failure?: { reason: string; message: string } | null
}

describe('placing blocks above the bot on a real Minecraft server', () => {
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
  const is = (position: Position, block: string): Promise<boolean> => world.isBlock(position, block)

  const untilBotCarries = (item: string): Promise<unknown> =>
    waitUntil(
      async () => {
        const result = await session.bot.call('get_inventory')
        const items = result.isError ? [] : (result.data as { items: { name: string }[] }).items
        return items.some((entry) => entry.name === item) ? true : undefined
      },
      { description: `the bot to carry ${item}` },
    )

  async function placeBlock(block: string, at: Position) {
    const first = await session.bot.call('place_block', {
      block,
      x: at.x,
      y: at.y,
      z: at.z,
      wait_seconds: 30,
    })
    if (first.isError) return { failed: true as const, text: first.text }
    let task = first.data as TaskView
    if (task.status === 'running') {
      task = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 90_000, description: 'place_block to finish' },
      )
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task) }
  }

  it('places furnaces on top of furnaces: the click on a furnace must not open it', async () => {
    await world.give(bot(), 'furnace', 4)
    await world.give(bot(), 'torch', 2)
    await untilBotCarries('furnace')
    await untilBotCarries('torch')
    const tries: [string, Position][] = [
      ['furnace', cell(4, 0, -8)], // at feet level
      ['furnace', cell(4, 1, -8)], // on top of the first: one above the feet
      ['furnace', cell(5, 1, -8)], // beside that one, one above the feet, with nothing below it
      ['furnace', cell(4, 2, -8)], // two above the feet
      ['torch', cell(4, 3, -8)], // on top of that
    ]

    for (const [block, at] of tries) {
      const outcome = await placeBlock(block, at)
      if (outcome.failed) throw new Error(`${block} at ${JSON.stringify(at)}: ${outcome.text}`)
    }

    for (const [block, at] of tries) expect(await is(at, block)).toBe(true)
  }, 300_000)

  it('builds four furnaces in two rows with build', async () => {
    await world.give(bot(), 'furnace', 4)
    await untilBotCarries('furnace')

    const first = await session.bot.call('build', {
      blueprint: 'custom',
      params: { layers: [['FF'], ['FF']], legend: { F: 'furnace' } },
      origin: cell(4, 0, -8),
      wait_seconds: 50,
    })
    if (first.isError) throw new Error(`build failed: ${first.text}`)
    let task = first.data as TaskView
    if (task.status === 'running')
      task = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 120_000, description: 'the build to finish' },
      )
    if (task.status !== 'succeeded')
      throw new Error(`build did not succeed: ${JSON.stringify(task)}`)

    for (const dy of [0, 1])
      for (const dx of [0, 1]) expect(await is(cell(4 + dx, dy, -8), 'furnace')).toBe(true)
  }, 300_000)

  /** A fence along x at z = -12 (x 2 to 9) with a gate at x = 5, on the walking layer. */
  async function fenceWithGate(): Promise<void> {
    await world.fill(cell(2, 0, -12), cell(9, 0, -12), 'oak_fence')
    await world.setBlock(cell(5, 0, -12), 'oak_fence_gate[facing=south]')
  }

  const untilBotSees = (name: string): Promise<unknown> =>
    waitUntil(
      async () => {
        const result = await session.bot.call('find_blocks', { names: [name] })
        return !result.isError && (result.data as { count: number }).count >= 1 ? true : undefined
      },
      { description: `the bot to see ${name}` },
    )

  async function placeSign(args: Record<string, unknown>) {
    const first = await session.bot.call('place_sign', { wait_seconds: 45, ...args })
    if (first.isError) return { failed: true as const, text: first.text }
    let task = first.data as TaskView
    if (task.status === 'running')
      task = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 120_000, description: 'place_sign to finish' },
      )
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task) }
  }

  it('puts a standing sign on top of a fence beside a gate', async () => {
    await fenceWithGate()
    await world.give(bot(), 'oak_sign', 2)
    await untilBotCarries('oak_sign')
    await untilBotSees('oak_fence_gate')

    const placed = await placeSign({
      at: cell(4, 0, -12),
      face: 'top',
      text: 'Field',
      facing: 'south',
    })

    if (placed.failed) throw new Error(`place_sign failed: ${placed.text}`)
    expect(await is(cell(4, 1, -12), 'oak_sign')).toBe(true)
  }, 300_000)

  it('names a free place when a torch is on the fence top, and swaps the torch when told to', async () => {
    await fenceWithGate()
    await world.setBlock(cell(7, 1, -12), 'torch')
    await world.give(bot(), 'oak_sign', 2)
    await untilBotCarries('oak_sign')
    await untilBotSees('torch')

    const refused = await placeSign({ at: cell(7, 0, -12), face: 'top', text: 'Field' })

    expect(refused.failed).toBe(true)
    expect(refused.text).toContain('taken by torch')
    expect(refused.text).toContain('Free instead')
    expect(refused.text).toContain('replace_block: true')
    expect(await is(cell(7, 1, -12), 'torch')).toBe(true) // untouched until asked

    const swapped = await placeSign({
      at: cell(7, 0, -12),
      face: 'top',
      text: 'Field',
      replace_block: true,
    })

    if (swapped.failed) throw new Error(`place_sign failed: ${swapped.text}`)
    expect(await is(cell(7, 1, -12), 'oak_sign')).toBe(true)
  }, 300_000)
})
