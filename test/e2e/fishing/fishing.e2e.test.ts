import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { waitUntil } from '../support/wait.js'

const cell = (x: number, dy: number, z: number): Position => ({ x, y: GROUND_Y + dy, z })
/** A pond two blocks deep, cut into the two top layers of the flat ground. */
const POND = { from: cell(8, -2, -10), to: cell(12, -1, -6) }

interface TaskView {
  status: string
  result: Record<string, unknown> | null
}

describe('fishing on a real Minecraft server', () => {
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
    if (sessionOpen) {
      sessionOpen = false
      await session.close()
    }
    // Back to solid ground: dirt under grass.
    await world.fill(POND.from, cell(12, -2, -6), 'dirt')
    await world.fill(cell(8, -1, -10), POND.to, 'grass_block')
  })

  afterAll(async () => {
    await world.close()
  })

  const bot = (): string => session.bot.username

  const untilBotCarries = (item: string): Promise<true> =>
    waitUntil(
      async () => {
        const result = await session.bot.call('get_inventory')
        const items = result.isError ? [] : (result.data as { items: { name: string }[] }).items
        return items.some((entry) => entry.name === item) ? true : undefined
      },
      { description: `the bot to carry ${item}` },
    )

  /** RCON changes reach the bot a moment later: wait until its own view shows the water. */
  const untilBotSeesWater = (): Promise<true> =>
    waitUntil(
      async () => {
        const seen = await session.bot.call('find_blocks', { names: ['water'], max_distance: 32 })
        return !seen.isError && (seen.data as { count: number }).count >= 10 ? true : undefined
      },
      { description: 'the bot to see the pond' },
    )

  async function fish(args: Record<string, unknown>) {
    const first = await session.bot.call('fish', { wait_seconds: 45, ...args })
    if (first.isError) return { failed: true as const, text: first.text, task: undefined }
    let task = first.data as TaskView
    if (task.status === 'running') {
      task = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 280_000, description: 'fishing to finish' },
      )
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  async function digPond(): Promise<void> {
    await world.fill(POND.from, POND.to, 'water')
    await untilBotSeesWater()
  }

  it('walks to the pond, casts, and catches at least one fish', async () => {
    await world.give(bot(), 'fishing_rod')
    await untilBotCarries('fishing_rod')
    await digPond()

    const run = await fish({ count: 1, max_minutes: 4 })

    if (run.failed) throw new Error(`fish did not succeed: ${run.text}`)
    expect(run.task.result).toMatchObject({ stopped: 'count', caught: 1 })
    expect((run.task.result as { casts: number }).casts).toBeGreaterThanOrEqual(1)
    const at = await world.playerPosition(bot())
    // On the shore, not in the water (the pond is x 8..12, z -10..-6).
    expect(at.x > 7.5 && at.x < 13.5 && at.z > -10.5 && at.z < -5.5).toBe(false)
  }, 300_000)

  it('fails no_rod, naming what a rod is made of, when the bot carries none', async () => {
    await digPond()

    const run = await fish({ count: 1 })

    expect(run.failed).toBe(true)
    expect(run.text).toContain('no_rod')
    expect(run.text).toContain('sticks')
  }, 120_000)

  it('fails no_water when there is no pond in sight', async () => {
    await world.give(bot(), 'fishing_rod')
    await untilBotCarries('fishing_rod')

    const run = await fish({ count: 1, max_minutes: 1 })

    expect(run.failed).toBe(true)
    expect(run.text).toContain('no_water')
  }, 120_000)
})
