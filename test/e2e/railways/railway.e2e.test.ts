import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { pause, waitUntil } from '../support/wait.js'

/** The walking layer: where rails stand. */
const walk = (x: number, z: number, dy = 0): Position => ({ x, y: GROUND_Y + dy, z })

interface TaskView {
  status: string
  result: Record<string, unknown> | null
}

describe('railways on a real Minecraft server', () => {
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
  })

  afterAll(async () => {
    await world.close()
  })

  const bot = (): string => session.bot.username

  async function give(item: string, count: number): Promise<void> {
    await world.give(bot(), item, count)
    await waitUntil(
      async () => {
        const result = await session.bot.call('get_inventory')
        const items = result.isError ? [] : (result.data as { items: { name: string; count: number }[] }).items
        return items.filter((i) => i.name === item).reduce((sum, i) => sum + i.count, 0) >= count ? true : undefined
      },
      { description: `the bot to carry ${String(count)} ${item}` },
    )
  }

  async function run(tool: string, args: Record<string, unknown>) {
    const first = await session.bot.call(tool, { wait_seconds: 45, ...args })
    if (first.isError) return { failed: true as const, text: first.text, task: undefined }
    let task = first.data as TaskView
    if (task.status === 'running') {
      task = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 240_000, description: `${tool} to finish` },
      )
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  const is = (position: Position, block: string): Promise<boolean> => world.isBlock(position, block)

  async function cartPosition(): Promise<Position | undefined> {
    const response = await world.command('data get entity @e[type=minecart,limit=1] Pos', true)
    const match = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(response)
    return match === null ? undefined : { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) }
  }

  /** Waits for the cart to come to rest (or get far enough), and returns how far along x it got. */
  async function untilCartReaches(x: number): Promise<Position> {
    return waitUntil(
      async () => {
        const at = await cartPosition()
        return at !== undefined && at.x >= x ? at : undefined
      },
      { timeoutMs: 60_000, intervalMs: 500, description: `the cart to reach x = ${String(x)}` },
    )
  }

  it('builds a flat economy line: rails, powered rails with torches, a buffer, and a cart that runs it', async () => {
    await give('rail', 30)
    await give('powered_rail', 8)
    await give('redstone_torch', 6)
    await give('cobblestone', 10)
    await give('minecart', 1)
    const start = walk(-6, -6)
    const end = walk(14, -6)

    const built = await run('build_railway', { to: end, label: 'flat line' })

    if (built.failed) throw new Error(`build_railway did not succeed: ${built.text}`)
    expect(built.task.result).toMatchObject({
      rails: 21,
      layout: 'surface',
      variant: 'economy',
      poweredRails: 6,
      torches: 3,
      verification: { checked: 21, problems: [] },
    })
    for (let x = -6; x <= 14; x += 1) {
      const powered = [-6, -5, -4, -3, 5, 13].includes(x)
      expect(await is(walk(x, -6), powered ? 'powered_rail' : 'rail')).toBe(true)
    }
    for (const x of [-6, 5, 13]) expect(await is(walk(x, -7), 'redstone_torch')).toBe(true)
    expect(await is(walk(-7, -6), 'cobblestone')).toBe(true)
    expect(dataOf<{ start: Position }>({ isError: false, text: '', data: built.task.result }).start).toEqual(start)

    const placed = await run('place_minecart', {})
    if (placed.failed) throw new Error(`place_minecart did not succeed: ${placed.text}`)
    const reached = await untilCartReaches(end.x - 1)
    expect(reached.x).toBeGreaterThanOrEqual(end.x - 1)
    await pause(200)
  })

  async function stock(rails = 60, powered = 12, torches = 12): Promise<void> {
    await give('rail', rails)
    await give('powered_rail', powered)
    await give('redstone_torch', torches)
    await give('cobblestone', 30)
    await give('minecart', 1)
    await give('iron_pickaxe', 1)
  }

  /** RCON changes reach the bot's own view a moment later: wait until it sees at least `count` of the block. */
  const untilBotSees = (name: string, count: number): Promise<unknown> =>
    waitUntil(
      async () => {
        const result = await session.bot.call('find_blocks', { names: [name], max_distance: 30, count: 50 })
        return !result.isError && (result.data as { count: number }).count >= count ? true : undefined
      },
      { description: `the bot to see ${String(count)} ${name}` },
    )

  it('goes around a wall somebody built, with curves, and the cart still runs it', async () => {
    await stock()
    for (let z = -10; z <= -3; z += 1) await world.fill(walk(4, z), walk(4, z, 1), 'stone_bricks')
    await untilBotSees('stone_bricks', 16)
    const end = walk(14, -6)

    const built = await run('build_railway', { to: end })

    if (built.failed) throw new Error(`build_railway did not succeed: ${built.text}`)
    const result = built.task.result as { corners: Position[]; verification: { problems: unknown[] } }
    expect(result.corners.length).toBeGreaterThanOrEqual(2)
    expect(result.verification.problems).toEqual([])
    for (let z = -10; z <= -3; z += 1) expect(await is(walk(4, z), 'stone_bricks')).toBe(true)
    const placed = await run('place_minecart', {})
    if (placed.failed) throw new Error(`place_minecart did not succeed: ${placed.text}`)
    await untilCartReaches(end.x - 1)
  })

  it('climbs over a low rise on slopes, and the cart makes it over', async () => {
    await stock()
    await world.fill(walk(0, -12, -1), walk(6, 0, 1), 'stone')
    await untilBotSees('stone', 40)
    const end = walk(14, -6)

    const built = await run('build_railway', { to: end })

    if (built.failed) throw new Error(`build_railway did not succeed: ${built.text}`)
    const result = built.task.result as { slopes: number; verification: { problems: unknown[] } }
    expect(result.slopes).toBeGreaterThan(0)
    expect(result.verification.problems).toEqual([])
    const placed = await run('place_minecart', {})
    if (placed.failed) throw new Error(`place_minecart did not succeed: ${placed.text}`)
    await untilCartReaches(end.x - 1)
  })

  it('builds the rich variant: powered rails all the way, a torch about every nine', async () => {
    await stock(40, 40, 10)
    const end = walk(14, -6)

    const built = await run('build_railway', { to: end, variant: 'rich' })

    if (built.failed) throw new Error(`build_railway did not succeed: ${built.text}`)
    expect(built.task.result).toMatchObject({ rails: 21, poweredRails: 21, torches: 3 })
    for (let x = -6; x <= 14; x += 1) expect(await is(walk(x, -6), 'powered_rail[powered=true]')).toBe(true)
    const placed = await run('place_minecart', {})
    if (placed.failed) throw new Error(`place_minecart did not succeed: ${placed.text}`)
    await untilCartReaches(end.x - 1)
  })

  it('digs a lit tunnel through a hill, and the cart runs through it', async () => {
    await stock()
    await give('torch', 20)
    await world.fill(walk(0, -12, 0), walk(8, -1, 8), 'stone')
    await untilBotSees('stone', 40)
    const end = walk(14, -6)

    const built = await run('build_railway', { to: end, layout: 'underground', depth: 2 })

    if (built.failed) throw new Error(`build_railway did not succeed: ${built.text}`)
    expect(built.task.result).toMatchObject({ layout: 'underground', verification: { problems: [] } })
    expect((built.task.result as { cuts: number }).cuts).toBeGreaterThan(10)
    const placed = await run('place_minecart', {})
    if (placed.failed) throw new Error(`place_minecart did not succeed: ${placed.text}`)
    await untilCartReaches(end.x - 1)
  }, 400_000)

  it('plan_railway changes nothing, and building without the rails says what to craft', async () => {
    const end = walk(14, -6)

    const plan = dataOf<{ rails: number; missing: { name: string }[]; crafting: { name: string; count: number }[] }>(
      await session.bot.call('plan_railway', { to: end }),
    )

    expect(plan.rails).toBe(21)
    expect(plan.missing.map((m) => m.name)).toEqual(expect.arrayContaining(['rail', 'powered_rail', 'redstone_torch']))
    expect(plan.crafting.map((c) => c.name)).toEqual(expect.arrayContaining(['iron_ingot', 'gold_ingot', 'redstone', 'stick']))
    expect(await is(walk(-6, -6), 'rail')).toBe(false)

    const built = await run('build_railway', { to: end, fetch_from_storage: false })

    expect(built.failed).toBe(true)
    expect(built.text).toContain('missing_materials')
  })
})
