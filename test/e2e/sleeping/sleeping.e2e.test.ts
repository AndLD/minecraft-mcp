import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { pause, waitUntil } from '../support/wait.js'

const cell = (x: number, z: number): Position => ({ x, y: GROUND_Y, z })

interface TaskView {
  status: string
  result: Record<string, unknown> | null
}

describe('sleeping on a real Minecraft server', () => {
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
    await world.setGameRule('playersSleepingPercentage', 100)
    await world.setGameRule('doDaylightCycle', false)
    await world.setDifficulty('peaceful')
    await world.setTime('day')
    if (!sessionOpen) return
    sessionOpen = false
    await session.close()
  })

  afterAll(async () => {
    await world.close()
  })

  const bot = (): string => session.bot.username

  /** A whole bed by RCON: the foot at (x, z) and the head one block east. */
  async function makeBed(x: number, z: number, colour = 'red'): Promise<void> {
    await world.setBlock(cell(x, z), `minecraft:${colour}_bed[facing=east,part=foot]`)
    await world.setBlock(cell(x + 1, z), `minecraft:${colour}_bed[facing=east,part=head]`)
    // RCON changes reach the bot a moment later.
    await waitUntil(
      async () => {
        const found = await session.bot.call('find_blocks', { names: [`${colour}_bed`], count: 4 })
        return !found.isError && (found.data as { blocks: unknown[] }).blocks.length >= 2
          ? true
          : undefined
      },
      { description: 'the bot to see the bed' },
    )
  }

  async function run(tool: string, args: Record<string, unknown> = {}) {
    const first = await session.bot.call(tool, { wait_seconds: 50, ...args })
    if (first.isError) return { failed: true as const, text: first.text, task: undefined }
    let task = first.data as TaskView
    if (task.status === 'running') {
      task = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 120_000, description: `${tool} to finish` },
      )
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  async function daytime(): Promise<number> {
    const reply = await world.command('time query daytime')
    return Number(/(\d+)/.exec(reply)?.[1] ?? '-1')
  }

  async function spawnPointOf(player: string): Promise<number | undefined> {
    const reply = await world.command(`data get entity ${player} SpawnX`, true)
    const match = /(-?\d+)\D*$/.exec(reply.trim())
    return match === null ? undefined : Number(match[1])
  }

  const beds = async () =>
    dataOf<{
      beds: { colour: string; respawnPoint: boolean; intact: boolean }[]
      respawnPoint: unknown
    }>(await session.bot.call('list_beds'))

  it('places a bed it carries as two blocks in a row, and remembers it', async () => {
    await world.give(bot(), 'red_bed', 1)
    await waitUntil(
      async () => {
        const inventory = await session.bot.call('get_inventory')
        const items = inventory.isError
          ? []
          : (inventory.data as { items: { name: string }[] }).items
        return items.some((i) => i.name === 'red_bed') ? true : undefined
      },
      { description: 'the bot to carry the bed' },
    )

    const placed = await run('place_bed')

    if (placed.failed) throw new Error(placed.text)
    const result = placed.task.result as { foot: Position; head: Position }
    expect(await world.isBlock(result.foot, 'red_bed')).toBe(true)
    expect(await world.isBlock(result.head, 'red_bed')).toBe(true)
    expect((await beds()).beds).toHaveLength(1)
  })

  describe('in a house', () => {
    // A 5 by 5 house from the `house` blueprint: floor corner (2, -12), interior x 3..5 and z -11..-9, the doorway
    // at x = 4 in the north wall (z = -12).
    const inside = (p: Position): boolean => p.x >= 3 && p.x <= 5 && p.z >= -11 && p.z <= -9

    async function houseWithBotInside(): Promise<void> {
      await world.give(bot(), 'oak_planks', 100)
      await world.give(bot(), 'oak_door', 1)
      await world.give(bot(), 'red_bed', 2)
      await waitUntil(
        async () => {
          const inventory = await session.bot.call('get_inventory')
          const items = inventory.isError
            ? []
            : (inventory.data as { items: { name: string }[] }).items
          return ['oak_planks', 'oak_door', 'red_bed'].every((n) => items.some((i) => i.name === n))
            ? true
            : undefined
        },
        { description: 'the bot to carry the materials' },
      )
      const built = await run('build', {
        blueprint: 'house',
        params: { width: 5, depth: 5 },
        origin: { x: 2, y: GROUND_Y, z: -12 },
      })
      if (built.failed) throw new Error(`The house was not built: ${built.text}`)
      await world.teleport(bot(), { x: 4.5, y: GROUND_Y + 1, z: -9.5 })
      await waitUntil(
        async () => {
          const status = dataOf<{ vitals: { position: Position } | null }>(
            await session.bot.call('get_status'),
          )
          const at = status.vitals?.position
          return at !== undefined && at.z > -11 && at.z < -9 && Math.abs(at.y - (GROUND_Y + 1)) < 1
            ? true
            : undefined
        },
        { description: 'the bot to stand inside the house' },
      )
    }

    it('puts the bed inside, against a wall, and not in front of the door', async () => {
      await houseWithBotInside()

      const placed = await run('place_bed')

      if (placed.failed) throw new Error(placed.text)
      const { foot, head } = placed.task.result as { foot: Position; head: Position }
      const bedY = GROUND_Y + 1
      expect(await world.isBlock({ ...foot, y: bedY }, 'red_bed')).toBe(true)
      expect(await world.isBlock({ ...head, y: bedY }, 'red_bed')).toBe(true)
      expect(inside(foot) && inside(head)).toBe(true)
      const wall = (p: Position): boolean => p.x === 3 || p.x === 5 || p.z === -11 || p.z === -9
      expect(wall(foot) && wall(head)).toBe(true)
      // Nothing of the bed touches the cell in front of the doorway.
      for (const p of [foot, head]) expect(p.x === 4 && p.z === -11).toBe(false)
    })

    it('puts a bed into a protected house only when told the cell', async () => {
      await houseWithBotInside()
      const protectedHouse = await session.bot.call('protect_area', {
        x1: 2,
        y1: GROUND_Y,
        z1: -12,
        x2: 6,
        y2: GROUND_Y + 4,
        z2: -8,
        label: 'house',
      })
      expect(protectedHouse.isError).toBe(false)

      const refused = await run('place_bed')
      const named = await run('place_bed', { at: { x: 5, y: GROUND_Y + 1, z: -10 } })

      expect(refused.failed).toBe(true)
      expect(refused.text).toContain('no_space')
      if (named.failed) throw new Error(named.text)
      expect(await world.isBlock({ x: 5, y: GROUND_Y + 1, z: -10 }, 'red_bed')).toBe(true)
    })
  })

  it('sets the respawn point by day, and the game confirms it', async () => {
    await makeBed(-3, -5)

    const set = await run('set_respawn_point')

    expect(set.failed).toBe(false)
    expect((await beds()).respawnPoint).toMatchObject({ colour: 'red', respawnPoint: true })
    await waitUntil(
      async () => {
        const x = await spawnPointOf(bot())
        return x !== undefined && Math.abs(x - -3) <= 1 ? true : undefined
      },
      { description: 'the server to record the bed as the spawn point' },
    )
  })

  it('sleeps through the night when the server lets one player skip it', async () => {
    await world.setGameRule('playersSleepingPercentage', 0)
    await world.setGameRule('doDaylightCycle', true)
    await world.setTime('18000')
    await makeBed(-3, -5)

    const slept = await run('sleep', { stay_seconds: 60 })

    if (slept.failed) throw new Error(slept.text)
    expect(slept.text).toContain('"nightSkipped":true')
    expect(await daytime()).toBeLessThan(6000)
    expect((await beds()).respawnPoint).toMatchObject({ colour: 'red' })
  })

  it('reports that the night was not skipped when another player is awake', async () => {
    await world.setGameRule('playersSleepingPercentage', 100)
    await world.setGameRule('doDaylightCycle', true)
    await world.setTime('18000')
    await makeBed(-3, -5)

    const slept = await run('sleep', { stay_seconds: 8 })

    expect(slept.failed).toBe(false)
    expect(slept.task?.result).toMatchObject({ nightSkipped: false, wokeEarly: false })
    expect(await daytime()).toBeGreaterThan(12_000)
  })

  it('refuses to sleep by day, pointing at set_respawn_point', async () => {
    await makeBed(-3, -5)

    const tried = await run('sleep')

    expect(tried.failed).toBe(true)
    expect(tried.text).toContain('not_night')
  })

  it('refuses to sleep with a hostile mob beside the bed', async () => {
    await world.setTime('18000')
    await world.setDifficulty('easy')
    await makeBed(-3, -5)
    await world.summonWith(
      'zombie',
      { x: -1.5, y: GROUND_Y, z: -3.5 },
      '{NoAI:1b,PersistenceRequired:1b}',
    )

    const outcome = await waitUntil(
      async () => {
        const tried = await run('sleep', { stay_seconds: 5 })
        return tried.text.includes('monsters_nearby') ? tried : undefined
      },
      { description: 'the bot to see the zombie and refuse to sleep' },
    )

    expect(outcome.failed).toBe(true)
    expect(await world.isBlock(cell(-3, -5), 'red_bed')).toBe(true)
  })

  it('wakes up at the bed after a death, and notices when the bed is gone', async () => {
    const far = 40
    await world.teleport(bot(), { x: far - 2 + 0.5, y: GROUND_Y, z: 0.5 })
    await waitUntil(
      async () => {
        const status = dataOf<{ vitals: { position: Position } | null }>(
          await session.bot.call('get_status'),
        )
        return status.vitals !== null && Math.abs(status.vitals.position.x - (far - 1.5)) < 2
          ? true
          : undefined
      },
      { description: 'the bot to arrive at the far bed' },
    )
    await makeBed(far, 0)
    expect((await run('set_respawn_point')).failed).toBe(false)

    await world.command(`kill ${bot()}`)
    const atBed = await waitUntil(
      async () => {
        const where = await world.playerPosition(bot())
        return Math.abs(where.x - far) < 5 && Math.abs(where.z) < 5 ? where : undefined
      },
      { description: 'the bot to wake up at its bed after dying' },
    )
    expect(atBed.x).toBeGreaterThan(far - 5)
    await pause(3_000)

    // Breaking the foot pops the head off with it.
    await world.setBlock(cell(far, 0), 'minecraft:air')
    await pause(1_500)
    await world.command(`kill ${bot()}`)
    const noticed = await waitUntil(
      async () => {
        const events = await session.bot.call('wait_for_chat', { timeout_seconds: 2 })
        return events.text.includes('respawn_point_lost') ? events.text : undefined
      },
      { timeoutMs: 60_000, description: 'the bot to notice the bed is gone' },
    )

    expect(noticed).toContain('did not wake up at its bed')
    expect((await beds()).beds[0]).toMatchObject({ respawnPoint: false, intact: false })
  })
})
