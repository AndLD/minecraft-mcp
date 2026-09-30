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
  result: { layout: string; mined: number; explored: number; tunnelled: number } | null
}

describe('gathering ore by open veins on a real Minecraft server', () => {
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
    await world.fill(cell(20, 0, -8), cell(90, 9, 10), 'air')
  })

  afterAll(async () => {
    await world.close()
  })

  const carrying = (item: string): Promise<true> =>
    waitUntil(
      async () => {
        const inventory = await session.bot.call('get_inventory')
        const items = inventory.isError
          ? []
          : (inventory.data as { items: { name: string }[] }).items
        return items.some((entry) => entry.name === item) ? true : undefined
      },
      { description: `the bot to carry ${item}` },
    )

  /** A hill of stone with a 2-high tunnel along z 0 from x 20 (the mouth) to x 80. */
  async function hillWithTunnel(): Promise<void> {
    await world.fill(cell(20, 0, -6), cell(82, 8, 6), 'stone')
    await world.fill(cell(20, 0, 0), cell(80, 1, 0), 'air')
  }

  async function collect(args: Record<string, unknown>) {
    const first = await session.bot.call('collect_block', { wait_seconds: 40, ...args })
    if (first.isError) return { failed: true as const, text: first.text, task: undefined }
    let task = first.data as TaskView
    if (task.status === 'running') {
      task = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 280_000, description: 'the gathering to finish' },
      )
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  async function equip(): Promise<void> {
    await world.give(session.bot.username, 'torch', 30)
    await world.give(session.bot.username, 'stone_pickaxe')
    await carrying('stone_pickaxe')
    await world.teleport(session.bot.username, { x: 14.5, y: GROUND_Y, z: 0.5 })
  }

  it('walks into a cave to a vein 60 blocks away instead of tunnelling, and digs it', async () => {
    await hillWithTunnel()
    await world.setBlock(cell(72, 0, 1), 'iron_ore') // in the tunnel wall, far from the bot
    await equip()

    const run = await collect({ blocks: ['iron_ore'], count: 1 })

    if (run.failed) throw new Error(`The gathering did not succeed: ${run.text}`)
    expect(run.task.result).toMatchObject({
      layout: 'open_veins',
      mined: 1,
      explored: 1,
      tunnelled: 0,
    })
    expect(await world.isBlock(cell(72, 0, 1), 'iron_ore')).toBe(false)
  }, 300_000)

  it('does not tunnel to a buried vein by default, and says how to reach it', async () => {
    await hillWithTunnel()
    await world.setBlock(cell(40, 0, 4), 'iron_ore') // in solid rock, no open side
    await equip()

    const run = await collect({ blocks: ['iron_ore'], count: 1, max_minutes: 2 })

    expect(run.failed).toBe(true)
    expect(run.text).toContain('no_open_vein')
    expect(run.text).toContain('open_then_tunnel')
    expect(await world.isBlock(cell(40, 0, 4), 'iron_ore')).toBe(true)
  }, 300_000)

  it('digs a route to the buried vein with open_then_tunnel', async () => {
    await hillWithTunnel()
    await world.setBlock(cell(40, 0, 4), 'iron_ore')
    await equip()

    const run = await collect({
      blocks: ['iron_ore'],
      count: 1,
      search: 'open_then_tunnel',
      max_minutes: 4,
    })

    if (run.failed) throw new Error(`The gathering did not succeed: ${run.text}`)
    expect(run.task.result).toMatchObject({ mined: 1, tunnelled: 1 })
    expect(await world.isBlock(cell(40, 0, 4), 'iron_ore')).toBe(false)
  }, 300_000)
})
