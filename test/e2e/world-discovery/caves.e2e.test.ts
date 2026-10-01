import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { waitUntil } from '../support/wait.js'

const cell = (x: number, dy: number, z: number): Position => ({ x, y: GROUND_Y + dy, z })

interface CaveView {
  status: string
  result: {
    region: string
    stopped: string
    returned: boolean
    torchesPlaced: number
    restocked: { torches: number; trips: number }
    finds: { kind: string; name: string; x: number; z: number }[]
    mined: Record<string, number>
    skipped: { name: string; reason: string }[]
  } | null
}

describe('cave exploration on a real Minecraft server', () => {
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
    await world.fill(cell(20, 0, -6), cell(80, 9, 8), 'air')
    await world.fill(cell(12, 0, -3), cell(12, 0, -3), 'air')
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

  /** A hill of stone with a 2-high tunnel through it along z 0, from x 20 (the mouth) to x 75. */
  async function hillWithTunnel(): Promise<void> {
    await world.fill(cell(20, 0, -4), cell(78, 8, 4), 'stone')
    await world.fill(cell(20, 0, 0), cell(75, 1, 0), 'air')
  }

  const untilBotSees = (name: string): Promise<true> =>
    waitUntil(
      async () => {
        const seen = await session.bot.call('find_blocks', { names: [name], max_distance: 64 })
        return !seen.isError && (seen.data as { count: number }).count > 0 ? true : undefined
      },
      { description: `the bot to see ${name}` },
    )

  async function explore(args: Record<string, unknown>) {
    const first = await session.bot.call('explore_caves', { wait_seconds: 40, ...args })
    if (first.isError) return { failed: true as const, text: first.text, task: undefined }
    let task = first.data as CaveView
    if (task.status === 'running') {
      task = await waitUntil(
        async () => {
          const status = dataOf<{ task: CaveView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 280_000, description: 'the cave trip to finish' },
      )
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  it('goes in, lights the way, reports a diamond and a spawner, keeps clear of lava, and comes back out', async () => {
    await hillWithTunnel()
    await world.setBlock(cell(68, 0, 1), 'diamond_ore')
    await world.setBlock(cell(60, 0, 1), 'spawner')
    await world.setBlock(cell(50, 0, 2), 'lava') // a pocket behind a wall of stone, beside the path
    await world.give(session.bot.username, 'torch', 30)
    await carrying('torch')
    await world.teleport(session.bot.username, { x: 14.5, y: GROUND_Y, z: 0.5 })
    await untilBotSees('diamond_ore')

    const run = await explore({ max_distance: 100, min_light: 5 })

    if (run.failed) throw new Error(`The trip did not succeed: ${run.text}`)
    const result = run.task.result
    expect(result?.finds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'diamond_ore', x: 68 }),
        expect.objectContaining({ kind: 'spawner', x: 60 }),
      ]),
    )
    expect(result?.torchesPlaced).toBeGreaterThanOrEqual(3)
    expect(result?.returned).toBe(true)
    expect(await world.isBlock(cell(50, 0, 2), 'lava')).toBe(true)
    const back = await world.playerPosition(session.bot.username)
    expect(Math.hypot(back.x - 14.5, back.z - 0.5)).toBeLessThan(8)
    const saved = dataOf<{ finds: { name: string }[] }>(
      await session.bot.call('list_known_structures'),
    )
    expect(saved.finds.map((find) => find.name)).toContain('diamond_ore')
  }, 300_000)

  it('fetches torches from a chest before going in when the bot has none, then lights the way', async () => {
    await hillWithTunnel()
    await world.setBlock(cell(68, 0, 1), 'diamond_ore')
    await world.setBlock(cell(12, 0, -3), 'chest')
    await world.fillSlot(cell(12, 0, -3), 0, 'torch', 64)
    await world.teleport(session.bot.username, { x: 14.5, y: GROUND_Y, z: 0.5 })
    await untilBotSees('chest')
    await untilBotSees('diamond_ore')
    expect(
      (
        await session.bot.call('register_container', {
          x: 12,
          y: GROUND_Y,
          z: -3,
          label: 'lamps',
        })
      ).isError,
    ).toBe(false)

    const run = await explore({ max_distance: 100, min_light: 5 })

    if (run.failed) throw new Error(`The trip did not succeed: ${run.text}`)
    const result = run.task.result
    expect(result?.restocked).toMatchObject({ trips: 1 })
    expect(result?.restocked.torches).toBeGreaterThanOrEqual(30)
    expect(result?.torchesPlaced).toBeGreaterThanOrEqual(3)
    expect(result?.finds).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'diamond_ore', x: 68 })]),
    )
    expect(result?.returned).toBe(true)
    expect(await world.countInChest(cell(12, 0, -3), 'torch')).toBeLessThan(64)
  }, 300_000)

  it('says no_torches when the bot has none and no container holds any', async () => {
    await hillWithTunnel()
    await world.teleport(session.bot.username, { x: 14.5, y: GROUND_Y, z: 0.5 })
    await untilBotSees('stone')

    const run = await explore({ max_distance: 100 })

    if (run.failed) throw new Error(`The trip did not succeed: ${run.text}`)
    expect(run.task.result).toMatchObject({ stopped: 'no_torches', restocked: { trips: 0 } })
  }, 300_000)

  it('digs out an iron vein it passes when told to mine, with a pickaxe that can', async () => {
    await hillWithTunnel()
    await world.setBlock(cell(40, 0, 1), 'iron_ore')
    await world.setBlock(cell(41, 0, 1), 'iron_ore')
    await world.give(session.bot.username, 'torch', 30)
    await world.give(session.bot.username, 'stone_pickaxe')
    await carrying('stone_pickaxe')
    await world.teleport(session.bot.username, { x: 14.5, y: GROUND_Y, z: 0.5 })
    await untilBotSees('iron_ore')

    const run = await explore({ find: ['iron_ore'], mine: true, max_distance: 100 })

    if (run.failed) throw new Error(`The trip did not succeed: ${run.text}`)
    expect(run.task.result?.mined).toMatchObject({ iron_ore: 2 })
    expect(await world.isBlock(cell(40, 0, 1), 'iron_ore')).toBe(false)
  }, 300_000)

  it('says there is no cave when the bot stands on open ground', async () => {
    await world.teleport(session.bot.username, { x: -30.5, y: GROUND_Y, z: 0.5 })

    const run = await explore({})

    expect(run.failed).toBe(true)
    expect(run.text).toContain('no_cave')
  }, 120_000)
})
