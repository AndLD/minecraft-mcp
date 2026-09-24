import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { waitUntil } from '../support/wait.js'

/** The ground block itself (one below the walking layer): what a sapling stands on. */
const floor = (x: number, z: number): Position => ({ x, y: GROUND_Y - 1, z })
const AREA = { from: floor(2, -12), to: floor(10, -2) }

interface TaskView {
  status: string
  result: Record<string, unknown> | null
}

interface Spot {
  x: number
  y: number
  z: number
}

interface GroveReport {
  ripe: number
  growing: number
  empty: number
}

describe('tree farming on a real Minecraft server', () => {
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

  const untilBotCarries = (item: string): Promise<unknown> =>
    waitUntil(
      async () => {
        const result = await session.bot.call('get_inventory')
        const items = result.isError ? [] : (result.data as { items: { name: string }[] }).items
        return items.some((entry) => entry.name === item) ? true : undefined
      },
      { description: `the bot to carry ${item}` },
    )

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
        { timeoutMs: 120_000, description: `${tool} to finish` },
      )
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  const is = (position: Position, block: string): Promise<boolean> => world.isBlock(position, block)

  const report = async (): Promise<GroveReport> => {
    const result = await session.bot.call('inspect_farm', { farm: 'oak wood' })
    return dataOf<{ components: GroveReport[] }>(result).components[0] ?? { ripe: 0, growing: 0, empty: 0 }
  }

  /** RCON changes reach the bot a moment later: wait until inspect_farm, which reads what the tools read, agrees. */
  const untilReport = (want: Partial<GroveReport>): Promise<GroveReport> =>
    waitUntil(
      async () => {
        const now = await report()
        return Object.entries(want).every(([key, value]) => now[key as keyof GroveReport] === value)
          ? now
          : undefined
      },
      { description: `inspect_farm to report ${JSON.stringify(want)}` },
    )

  /** Gives saplings, plants two oaks in the plot, and returns where they stand. */
  async function plantTwo(): Promise<Spot[]> {
    await world.give(bot(), 'oak_sapling', 3)
    await untilBotCarries('oak_sapling')
    const planted = await run('plant_trees', {
      species: 'oak',
      count: 2,
      area: AREA,
      label: 'oak wood',
    })
    if (planted.failed) throw new Error(`plant_trees did not succeed: ${planted.text}`)
    return (planted.task.result as { spots: Spot[] }).spots
  }

  it('previews spots, plants saplings there, and remembers a grove', async () => {
    await world.give(bot(), 'oak_sapling', 3)
    await untilBotCarries('oak_sapling')

    const preview = await run('plant_trees', { species: 'oak', count: 3, area: AREA, preview: true })
    if (preview.failed) throw new Error(`preview did not succeed: ${preview.text}`)
    expect(preview.task.result).toMatchObject({ mode: 'preview', planted: 0 })
    const previewed = (preview.task.result as { spots: Spot[] }).spots
    expect(previewed).toHaveLength(3)
    expect(await is(previewed[0] ?? floor(0, 0), 'oak_sapling')).toBe(false)

    const planted = await run('plant_trees', {
      species: 'oak',
      count: 3,
      area: AREA,
      label: 'oak wood',
    })

    if (planted.failed) throw new Error(`plant_trees did not succeed: ${planted.text}`)
    expect(planted.task.result).toMatchObject({ mode: 'plant', planted: 3, protectedArea: true })
    for (const spot of (planted.task.result as { spots: Spot[] }).spots)
      expect(await is(spot, 'oak_sapling')).toBe(true)
    const list = dataOf<{ farms: { label: string; kind: string; crop: string; spotCount: number }[] }>(
      await session.bot.call('list_farms'),
    )
    expect(list.farms).toContainEqual(
      expect.objectContaining({ label: 'oak wood', kind: 'grove', crop: 'oak', spotCount: 3 }),
    )
    expect(await report()).toMatchObject({ growing: 3, ripe: 0, empty: 0 })
  })

  it('fells a grown tree from the ground and plants a sapling where it stood', async () => {
    const [grown] = await plantTwo()
    if (grown === undefined) throw new Error('nothing planted')
    await world.fill(grown, { ...grown, y: grown.y + 3 }, 'oak_log')
    await untilReport({ ripe: 1, growing: 1 })

    const felled = await run('harvest_trees', { farm: 'oak wood' })

    if (felled.failed) throw new Error(`harvest_trees did not succeed: ${felled.text}`)
    expect(felled.task.result).toMatchObject({ trees: 1, logs: 4, left: 0, replanted: 1 })
    for (let dy = 1; dy <= 3; dy += 1) expect(await is({ ...grown, y: grown.y + dy }, 'air')).toBe(true)
    expect(await is(grown, 'oak_sapling')).toBe(true)
    const gained = (felled.task.result as { gained: { name: string; count: number }[] }).gained
    expect(gained).toContainEqual({ name: 'oak_log', count: 4 })
  })

  it('tend_farm plants a sapling again where a tree is gone, and never fells', async () => {
    const [kept, gone] = await plantTwo()
    if (kept === undefined || gone === undefined) throw new Error('nothing planted')
    await world.fill(kept, { ...kept, y: kept.y + 3 }, 'oak_log')
    await world.setBlock(gone, 'air')
    await untilReport({ ripe: 1, empty: 1 })

    const tended = await run('tend_farm', { farm: 'oak wood' })

    if (tended.failed) throw new Error(`tend_farm did not succeed: ${tended.text}`)
    expect(tended.task.result).toMatchObject({ components: [{ kind: 'grove', planted: 1 }] })
    expect(await is(gone, 'oak_sapling')).toBe(true)
    expect(await is({ ...kept, y: kept.y + 3 }, 'oak_log')).toBe(true)
  })
})
