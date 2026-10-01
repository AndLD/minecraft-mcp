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

describe('cave sealing on a real Minecraft server', () => {
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

  it('seals a cave beside a quarry wall and under a stair tread, and reaches the target depth', async () => {
    const origin = cell(9, -1, -6)
    await untilBotSeesFloor(origin)
    await world.give(bot(), 'cobblestone', 10)
    await waitUntil(
      async () => {
        const inventory = await session.bot.call('get_inventory')
        const items = inventory.isError
          ? []
          : (inventory.data as { items: { name: string }[] }).items
        return items.some((entry) => entry.name === 'cobblestone') ? true : undefined
      },
      { description: 'the bot to carry the cobblestone' },
    )
    // A cave beside the south wall of the footprint (x = 11, one south of it), outside the plan entirely.
    await world.setBlock(cell(11, -1, -3), 'air')
    // A cave right under the tread of the first stair step (the ring sits 1 out: x = 8, z = -7).
    await world.setBlock(cell(8, -2, -7), 'air')

    const run = await excavate({
      shape: 'quarry',
      params: { width: 3, length: 3, to_y: origin.y - 1, exit: 'stairs' },
      origin: { x: origin.x, y: origin.y, z: origin.z },
    })

    if (run.failed) throw new Error(`The dig did not succeed: ${run.text}`)
    // The wall cave is sealed, not left open into the quarry.
    expect(await is(cell(11, -1, -3), 'air')).toBe(false)
    // The column beside it still reached the bottom layer.
    expect(await is(cell(11, -2, -4), 'air')).toBe(true)
    // The tread is backfilled: something to stand on.
    expect(await is(cell(8, -2, -7), 'air')).toBe(false)
    // The headroom above it is still open.
    expect(await is(cell(8, -1, -7), 'air')).toBe(true)

    // The bot is in the pit: it walks out by the stairs.
    const surface = { x: 6.5, y: GROUND_Y, z: -6.5 }
    const first = await session.bot.call('goto', {
      x: surface.x,
      y: surface.y,
      z: surface.z,
      wait_seconds: 45,
    })
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
        { timeoutMs: 60_000, description: 'goto to finish' },
      )
    }
    if (out.status !== 'succeeded') {
      const here = await world.playerPosition(bot())
      throw new Error(
        `The bot could not walk out: ${JSON.stringify(out)}; it stands at ${JSON.stringify(here)}`,
      )
    }
    expect(out.result?.arrivedAt?.y).toBeGreaterThan(GROUND_Y - 0.5) // above the pit, not still down in it
  }, 240_000)
})
