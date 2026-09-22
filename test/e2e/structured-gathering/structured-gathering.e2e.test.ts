import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { waitUntil } from '../support/wait.js'

interface TaskView {
  taskId: string
  status: string
  progress: string | null
  result: Record<string, unknown> | null
}

/**
 * The bot starts each test at (-5.5, GROUND_Y, -5.5) (see `startSession`), so a default structured dig's
 * origin (two cells east of its feet, one below) lands at (-4, GROUND_Y - 1, -6). A patch of solid dirt, three
 * layers deep, wide enough for the biggest footprint the sizing logic ever picks (5x5), replaces the default
 * one-layer grass-over-dirt floor there so a bulk "dirt" request has real dirt to quarry into.
 */
const DIRT_PATCH: readonly [Position, Position] = [
  { x: -10, y: GROUND_Y - 1, z: -12 },
  { x: 10, y: GROUND_Y - 3, z: 2 },
]

describe('structured gathering on a real Minecraft server', () => {
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
    await world.fill(DIRT_PATCH[0], DIRT_PATCH[1], 'dirt')
    // RCON changes reach the bot a moment later: wait until it sees the new surface dirt, not just the
    // buried dirt that was already there under the default grass floor.
    await waitUntil(
      async () => {
        const result = await session.bot.call('find_blocks', {
          names: ['dirt'],
          max_distance: 20,
          count: 50,
        })
        if (result.isError) return undefined
        const blocks = (result.data as { blocks: { position: Position }[] }).blocks
        return blocks.some((block) => block.position.y === GROUND_Y - 1) ? true : undefined
      },
      { description: 'the bot to see the new surface dirt' },
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

  const bot = (): string => session.bot.username

  /** Starts a task-running tool and follows it until it is no longer running. */
  async function runToTheEnd(
    tool: string,
    args: Record<string, unknown>,
    timeoutMs = 100_000,
  ): Promise<{ failed: boolean; text: string; task: TaskView | undefined }> {
    const first = await session.bot.call(tool, { wait_seconds: 20, ...args })
    if (first.isError) return { failed: true, text: first.text, task: undefined }
    let task = first.data as TaskView
    if (task.status === 'running') {
      const finished = await waitUntil(
        async () => {
          const status = await session.bot.call('get_task_status')
          if (status.isError) throw new Error(`get_task_status failed: ${status.text}`)
          const view = (status.data as { task: TaskView }).task
          return view.status === 'running' ? undefined : view
        },
        { timeoutMs, description: `${tool} to finish` },
      )
      task = finished
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  function expectSucceeded(run: { failed: boolean; text: string }): void {
    if (run.failed) throw new Error(`The task did not succeed: ${run.text}`)
  }

  it('digs one contained quarry for a big bulk-dirt request instead of scattered holes', async () => {
    const run = await runToTheEnd('collect_block', { blocks: ['dirt'], count: 40 })

    expectSucceeded(run)
    expect(run.task?.result).toMatchObject({ layout: 'structured' })
    const result = run.task?.result as { shape: string; mined: number }
    expect(result.shape).toContain('quarry')
    expect(result.mined).toBeGreaterThanOrEqual(40)
    expect(await world.countItem(bot(), 'dirt')).toBeGreaterThanOrEqual(40)
  })

  it('still digs scattered for a small bulk-dirt request, unchanged', async () => {
    const run = await runToTheEnd('collect_block', { blocks: ['dirt'], count: 3 })

    expectSucceeded(run)
    expect(run.task?.result).toMatchObject({ layout: 'scattered', mined: 3 })
    expect(await world.countItem(bot(), 'dirt')).toBe(3)
  })

  it('falls back to scattered when the structured site is protected, and says why', async () => {
    // Covers the structured dig's default origin (-4, GROUND_Y - 1, -6) and the biggest footprint the sizing
    // logic ever picks (5x5, growing east and south from the origin), but leaves the bot's own spot and most
    // of the wider dirt patch open, so the scattered fallback has real, unprotected dirt to reach.
    const protectedArea = await session.bot.call('protect_area', {
      label: 'no digging here',
      x1: -5,
      y1: GROUND_Y - 4,
      z1: -7,
      x2: 1,
      y2: GROUND_Y + 4,
      z2: -1,
    })
    expect(protectedArea.isError).toBe(false)

    const run = await runToTheEnd('collect_block', { blocks: ['dirt'], count: 40 })

    expectSucceeded(run)
    expect(run.task?.result).toMatchObject({ layout: 'scattered', mined: 40 })
    const result = run.task?.result as { structuredFallbackReason?: string }
    expect(result.structuredFallbackReason).toMatch(/protected/)
    expect(await world.countItem(bot(), 'dirt')).toBe(40)
  })
})
