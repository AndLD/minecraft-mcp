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

describe('adjustable stair sizing on a real Minecraft server', () => {
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

  it('cuts a wider, taller staircase, and the bot walks out on it', async () => {
    // Origin away from x = 0..2: a pathfinder stall specific to that spot was found in the plain-stairs e2e
    // (see AGENTS.md e2e gotchas), unrelated to stair geometry.
    const origin = cell(9, -1, -6)
    await untilBotSeesFloor(origin)

    const run = await excavate({
      shape: 'pit',
      params: {
        width: 3,
        length: 3,
        depth: 3,
        exit: 'stairs',
        stair_width: 2,
        stair_height: 4,
      },
      origin: { x: origin.x, y: origin.y, z: origin.z },
    })

    if (run.failed) throw new Error(`The dig did not succeed: ${run.text}`)
    // The ring sits stair_width (2) cells out from the footprint (origin x=9, z=-6): west=7, north=-8.
    // Step 0 (layer 0, foot at y = -1) is a 2-cell-deep, 4-cell-tall band at x = 7, z = -8..-7.
    for (const z of [-8, -7])
      for (const dy of [-1, 0, 1, 2]) expect(await is(cell(7, dy, z), 'air')).toBe(true)
    // One cell further outward (z = -9, one before the ring's own edge) stays solid: exactly stair_width deep.
    expect(await is(cell(7, -1, -9), 'air')).toBe(false)

    // The bot is in the pit: it walks out by the stairs.
    // Well clear of the whole footprint and its 2-wide ring (which spans x = 7..13, z = -8..-3): reachable only
    // by climbing out on the stairs.
    const surface = { x: 15.5, y: GROUND_Y, z: -6.5 }
    const first = await session.bot.call('goto', {
      x: surface.x,
      y: surface.y,
      z: surface.z,
      wait_seconds: 45,
    })
    if (first.isError) throw new Error(`The bot could not walk out: ${first.text}`)
    let out = first.data as { status: string }
    if (out.status === 'running') {
      out = await waitUntil(
        async () => {
          const status = dataOf<{ task: { status: string } }>(
            await session.bot.call('get_task_status'),
          ).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 60_000, description: 'goto to finish' },
      )
    }
    // The tool's own arrival tolerance decides how close is "there"; that is what already proves the walk-out
    // succeeded (a stuck or blocked pathfinder would report a failure, not "succeeded").
    if (out.status !== 'succeeded') {
      const here = await world.playerPosition(bot())
      throw new Error(
        `The bot could not walk out: ${JSON.stringify(out)}; it stands at ${JSON.stringify(here)}`,
      )
    }
    const arrivedAt = (out as { result?: { arrivedAt?: Position } }).result?.arrivedAt
    expect(arrivedAt?.y).toBeGreaterThan(GROUND_Y - 0.5) // above the pit, not still down in it
    expect(
      Math.hypot((arrivedAt?.x ?? 0) - surface.x, (arrivedAt?.z ?? 0) - surface.z),
    ).toBeLessThan(3)
  }, 240_000)
})
