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

describe('continuing a dig on a real Minecraft server', () => {
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
    // The arena reset only restores the top layer of the floor: fill the layers below back in after earlier digs
    // (deep enough for a quarry that is deepened later).
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

  /** Walks the bot to the surface beside the quarry and returns the height it arrives at. */
  async function walkOut(): Promise<number | undefined> {
    const first = await session.bot.call('goto', { x: 6.5, y: GROUND_Y, z: -6.5, wait_seconds: 45 })
    if (first.isError) throw new Error(`The bot could not walk out: ${first.text}`)
    let out = first.data as { status: string; result?: { arrivedAt?: Position } }
    if (out.status === 'running') {
      out = await waitUntil(
        async () => {
          const status = dataOf<{ task: { status: string; result?: { arrivedAt?: Position } } }>(
            await session.bot.call('get_task_status'),
          ).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 90_000, description: 'goto to finish' },
      )
    }
    if (out.status !== 'succeeded') {
      const here = await world.playerPosition(bot())
      throw new Error(
        `The bot could not walk out: ${JSON.stringify(out)}; it stands at ${JSON.stringify(here)}`,
      )
    }
    return out.result?.arrivedAt?.y
  }

  /** The step k of a 3x3 quarry's stair ring (origin at 9, -6): one cell east per step along the north side, one lower. */
  const stepCells = (origin: Position, k: number): Position[] =>
    [0, 1, 2, 3].map((dy) => ({ x: origin.x - 1 + k, y: origin.y - k + dy, z: origin.z - 1 }))

  it('deepens a quarry with stairs: the new steps join the old ones, and the bot walks out again', async () => {
    const origin = cell(9, -1, -6)
    await untilBotSeesFloor(origin)

    const first = await excavate({
      shape: 'quarry',
      params: { width: 3, length: 3, to_y: origin.y, exit: 'stairs' },
      origin: { x: origin.x, y: origin.y, z: origin.z },
    })
    if (first.failed) throw new Error(`The first dig did not succeed: ${first.text}`)

    const deeper = await excavate({
      shape: 'quarry',
      params: { to_y: origin.y - 2 },
      continue_existing: true,
    })

    if (deeper.failed) throw new Error(`The deeper dig did not succeed: ${deeper.text}`)
    expect(deeper.task.result).toMatchObject({
      continued: { existingLayers: 1, addLayers: 2 },
      ended: [],
    })
    for (const k of [0, 1, 2])
      for (const p of stepCells(origin, k)) expect(await is(p, 'air')).toBe(true)
    expect(await is({ x: origin.x + 1, y: origin.y - 2, z: origin.z + 1 }, 'air')).toBe(true)
    expect(await is({ x: origin.x + 1, y: origin.y - 3, z: origin.z + 1 }, 'air')).toBe(false)
    expect(await walkOut()).toBeGreaterThan(GROUND_Y - 0.5)
  }, 300_000)

  it('cuts the stair walls of a finished quarry from its bottom, and the bot walks out on them', async () => {
    const origin = cell(9, -1, -6)
    await untilBotSeesFloor(origin)

    const hole = await excavate({
      shape: 'quarry',
      params: { width: 3, length: 3, to_y: origin.y - 2, exit: 'none' },
      origin: { x: origin.x, y: origin.y, z: origin.z },
    })
    if (hole.failed) throw new Error(`The hole did not succeed: ${hole.text}`)

    const walls = await excavate({
      shape: 'quarry',
      params: { exit: 'stairs', order: 'bottom_up' },
      continue_existing: true,
    })

    if (walls.failed) throw new Error(`The walls did not succeed: ${walls.text}`)
    expect(walls.task.result).toMatchObject({ ended: [], continued: { addLayers: 0 } })
    for (const k of [0, 1, 2])
      for (const p of stepCells(origin, k)) expect(await is(p, 'air')).toBe(true)
    expect(await walkOut()).toBeGreaterThan(GROUND_Y - 0.5)
  }, 300_000)
})
