import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { waitUntil } from '../support/wait.js'

interface TaskView {
  status: string
  result: { broken: number; placed: number; ended: unknown[] } | null
}

/**
 * The bot starts each test at (-5.5, GROUND_Y, -5.5) (see `startSession`), so `staircase_down`'s default origin
 * (its own foot cell) lands at (-6, GROUND_Y, -6). A solid block of dirt, deeper than the default 3-layer floor,
 * replaces the ground under and beyond where the staircase (east, 4 steps, 3 wide) will descend, so there is real
 * material for every step and the wider corridor, not open void below the usual fixture depth.
 */
const ORIGIN: Position = { x: -6, y: GROUND_Y, z: -6 }
const FILL: readonly [Position, Position] = [
  { x: ORIGIN.x - 2, y: ORIGIN.y + 2, z: ORIGIN.z - 2 },
  { x: ORIGIN.x + 6, y: -63, z: ORIGIN.z + 4 },
]

describe('staircase target level and width on a real Minecraft server', () => {
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
    await world.fill(FILL[0], FILL[1], 'dirt')
    // RCON changes reach the bot a moment later: wait until it sees the deeper floor, not just the default one.
    await waitUntil(
      async () => {
        const seen = dataOf<{ blocks: number }>(
          await session.bot.call('preview_excavation', {
            shape: 'pit',
            params: { width: 1, length: 1, depth: 4, exit: 'none' },
            origin: ORIGIN,
          }),
        )
        return seen.blocks === 4 ? true : undefined
      },
      { description: 'the bot to see the deeper floor' },
    )
  })

  afterEach(async () => {
    if (!sessionOpen) return
    sessionOpen = false
    await session.close()
  })

  afterAll(async () => {
    await world.close()
  })

  const is = (position: Position, block: string): Promise<boolean> => world.isBlock(position, block)

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

  it('reaches an exact target level, fully open across a wider corridor, and leaves the tread solid', async () => {
    const run = await excavate({
      shape: 'staircase_down',
      params: { direction: 'east', to_y: ORIGIN.y - 3, stair_width: 3, torch_spacing: 0 },
      origin: ORIGIN,
    })

    if (run.failed) throw new Error(`The dig did not succeed: ${run.text}`)
    // 4 steps reach y = ORIGIN.y - 3; the last one is 3 blocks east, 3 down, 3 cells wide (z = ORIGIN.z..ORIGIN.z+2).
    const lastFoot = { x: ORIGIN.x + 3, y: ORIGIN.y - 3, z: ORIGIN.z }
    for (const dz of [0, 1, 2])
      for (const dy of [0, 1, 2, 3])
        expect(await is({ x: lastFoot.x, y: lastFoot.y + dy, z: lastFoot.z + dz }, 'air')).toBe(
          true,
        )
    // One cell further out (dz = 3) stays solid: exactly stair_width wide, not more.
    expect(await is({ x: lastFoot.x, y: lastFoot.y, z: lastFoot.z + 3 }, 'air')).toBe(false)
    // The tread (one below the last step, the bedrock layer here) is never dug: still solid ground to stand on.
    expect(await is({ x: lastFoot.x, y: lastFoot.y - 1, z: lastFoot.z }, 'air')).toBe(false)
  })
})
