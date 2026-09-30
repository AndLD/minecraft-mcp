import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { waitUntil } from '../support/wait.js'

const cell = (x: number, dy: number, z: number): Position => ({ x, y: GROUND_Y + dy, z })
const AREA = { from: cell(2, -1, -12), to: cell(10, -1, -2) }
const TRUNK = cell(6, 0, -7)
const HEIGHT = 12

interface TaskView {
  status: string
  result: Record<string, unknown> | null
}

describe('felling a tall tree on a real Minecraft server', () => {
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
    await world.fill(cell(6, 0, -7), cell(6, HEIGHT + 2, -7), 'air')
  })

  afterAll(async () => {
    await world.close()
  })

  const bot = (): string => session.bot.username

  /** RCON changes reach the bot a moment later: wait until its own view shows the whole trunk. */
  const untilBotSeesTrunk = (): Promise<true> =>
    waitUntil(
      async () => {
        const seen = await session.bot.call('find_blocks', {
          names: ['oak_log'],
          max_distance: 32,
          count: 32,
        })
        return !seen.isError && (seen.data as { count: number }).count >= HEIGHT ? true : undefined
      },
      { description: 'the bot to see the whole trunk' },
    )

  const untilBotCarries = (item: string, count: number): Promise<true> =>
    waitUntil(
      async () => {
        const result = await session.bot.call('get_inventory')
        const items = result.isError
          ? []
          : (result.data as { items: { name: string; count: number }[] }).items
        return (items.find((entry) => entry.name === item)?.count ?? 0) >= count ? true : undefined
      },
      { description: `the bot to carry ${String(count)} ${item}` },
    )

  async function harvest(args: Record<string, unknown>) {
    const first = await session.bot.call('harvest_trees', { wait_seconds: 45, area: AREA, ...args })
    if (first.isError) return { failed: true as const, text: first.text, task: undefined }
    let task = first.data as TaskView
    if (task.status === 'running') {
      task = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 180_000, description: 'harvest_trees to finish' },
      )
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  async function growTree(): Promise<void> {
    await world.fill(TRUNK, cell(6, HEIGHT - 1, -7), 'oak_log')
    await untilBotSeesTrunk()
  }

  it('climbs a tower of dirt, fells the whole tree, takes the tower down, and replants', async () => {
    await world.give(bot(), 'dirt', 16)
    await world.give(bot(), 'oak_sapling', 2)
    await untilBotCarries('dirt', 16)
    await growTree()

    const felled = await harvest({ replant: true })

    if (felled.failed) throw new Error(`harvest_trees did not succeed: ${felled.text}`)
    expect(felled.task.result).toMatchObject({ trees: 1, logs: HEIGHT, left: 0, replanted: 1 })
    expect(await world.isBlock(cell(6, HEIGHT - 1, -7), 'air')).toBe(true)
    expect(await world.isBlock(cell(6, 0, -7), 'oak_sapling')).toBe(true)
    // The tower is broken down block by block and picked up again.
    const back = await world.countItem(bot(), 'dirt')
    expect(back).toBeGreaterThanOrEqual(14)
    const at = await world.playerPosition(bot())
    expect(at.y).toBeLessThan(GROUND_Y + 2)
  }, 300_000)

  it('leaves the top of the tree with reach_tall: skip', async () => {
    await world.give(bot(), 'dirt', 16)
    await untilBotCarries('dirt', 16)
    await growTree()

    const felled = await harvest({ replant: false, reach_tall: 'skip' })

    if (felled.failed) throw new Error(`harvest_trees did not succeed: ${felled.text}`)
    expect(felled.task.result).toMatchObject({ trees: 0 })
    expect((felled.task.result as { left: number }).left).toBeGreaterThan(0)
    expect(await world.isBlock(cell(6, HEIGHT - 1, -7), 'oak_log')).toBe(true)
  }, 300_000)

  it('says how much dirt it lacked when it has none, and leaves the top', async () => {
    await growTree()

    const felled = await harvest({ replant: false })

    if (felled.failed) throw new Error(`harvest_trees did not succeed: ${felled.text}`)
    expect((felled.task.result as { scaffoldMissing: number }).scaffoldMissing).toBeGreaterThan(0)
    expect(await world.isBlock(cell(6, HEIGHT - 1, -7), 'oak_log')).toBe(true)
  }, 300_000)
})
