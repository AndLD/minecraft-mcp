import { afterEach, describe, expect, it } from '@jest/globals'
import { FakeBot } from '../fakes/fake-bot.js'
import { createHarness, type Harness } from './support/app-harness.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close().catch(() => undefined)
  harness = undefined
})

const at = (x: number, y: number, z: number) => ({ x, y, z })
const GROUND = 63
const AREA = { from: at(5, GROUND, -10), to: at(16, GROUND, 1) }

/** Dirt at y = 63 and 12 free blocks above it, over a wide floor. */
function flatFloor(bot: FakeBot): void {
  for (let x = -10; x <= 30; x += 1) {
    for (let z = -25; z <= 15; z += 1) {
      bot.setBlock(at(x, GROUND, z), 'dirt')
      for (let y = GROUND + 1; y <= GROUND + 12; y += 1) bot.setBlock(at(x, y, z), 'air')
    }
  }
}

async function start(saplings = 10): Promise<Harness> {
  const bot = new FakeBot().useGameData()
  flatFloor(bot)
  bot.entity = { position: at(10.5, 64, -5.5) }
  bot.physics = true
  if (saplings > 0) bot.addItems('oak_sapling', saplings)
  const h = await createHarness({}, { bot })
  harness = h
  bot.now = () => h.clock.now()
  const connected = await h.call('connect', { port: 34231 })
  if (connected.isError) throw new Error(connected.text)
  await h.call('wait_for_chat', { timeout_seconds: 1 })
  return h
}

async function pumped<T>(h: Harness, promise: Promise<T>): Promise<T> {
  const state = { done: false }
  const tracked = promise.finally(() => {
    state.done = true
  })
  while (!state.done) {
    h.scheduler.advance(250)
    await h.settle()
  }
  return tracked
}

const call = (h: Harness, name: string, args: Record<string, unknown> = {}) =>
  pumped(h, h.call(name, args))
const task = (result: { data: unknown }): Record<string, unknown> => result.data as Record<string, unknown>

interface Grove {
  spotCount: number
  bounds: unknown
}

async function grove(h: Harness): Promise<Grove> {
  const list = task(await h.call('list_farms')) as { farms: (Grove & { kind: string })[] }
  const found = list.farms.find((farm) => farm.kind === 'grove')
  if (found === undefined) throw new Error('no grove registered')
  return found
}

describe('tree farming through the MCP server', () => {
  it('previews spots, then plants them, remembers a protected grove, and reports its trees', async () => {
    const h = await start()

    const preview = await call(h, 'plant_trees', {
      species: 'oak',
      count: 4,
      area: AREA,
      preview: true,
      wait_seconds: 30,
    })
    expect(task(preview)).toMatchObject({ status: 'succeeded', result: { mode: 'preview', planted: 0 } })
    expect(h.bot.placed).toEqual([])
    expect(task(await h.call('list_farms'))).toMatchObject({ count: 0 })

    const planted = await call(h, 'plant_trees', {
      species: 'oak',
      count: 4,
      area: AREA,
      label: 'oak wood',
      wait_seconds: 30,
    })

    expect(task(planted)).toMatchObject({
      status: 'succeeded',
      result: { mode: 'plant', planted: 4, saplingsMissing: 0, protectedArea: true },
    })
    expect(h.bot.placed.filter((p) => p.name === 'oak_sapling')).toHaveLength(4)
    expect(await grove(h)).toMatchObject({ spotCount: 4 })
    expect(task(await h.call('list_protected_areas'))).toMatchObject({
      areas: [{ label: 'oak wood' }],
    })

    const inspected = await h.call('inspect_farm', { farm: 'oak wood' })
    expect(task(inspected)).toMatchObject({
      components: [{ kind: 'grove', crop: 'oak', ripe: 0, growing: 4, empty: 0 }],
    })
  })

  it('fails with no_saplings when the bot carries none', async () => {
    const h = await start(0)

    const result = await call(h, 'plant_trees', { species: 'oak', count: 2, area: AREA, wait_seconds: 30 })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('no_saplings')
    expect(task(await h.call('list_farms'))).toMatchObject({ count: 0 })
  })

  it('fells a grown tree and replants it, and tend_farm refills a gone one', async () => {
    const h = await start()
    await call(h, 'plant_trees', { species: 'oak', count: 3, area: AREA, label: 'oak wood', wait_seconds: 30 })
    const placed = h.bot.placed.filter((p) => p.name === 'oak_sapling').map((p) => p.position)
    const [grown, gone] = placed
    if (grown === undefined || gone === undefined) throw new Error('nothing planted')
    for (let dy = 0; dy < 4; dy += 1) h.bot.setBlock(at(grown.x, grown.y + dy, grown.z), 'oak_log')
    h.bot.setBlock(gone, 'air')

    const inspected = await h.call('inspect_farm', { farm: 'oak wood' })
    expect(task(inspected)).toMatchObject({ components: [{ ripe: 1, growing: 1, empty: 1 }] })

    const felled = await call(h, 'harvest_trees', { farm: 'oak wood', wait_seconds: 30 })

    expect(task(felled)).toMatchObject({
      status: 'succeeded',
      result: { trees: 1, logs: 4, left: 0, replanted: 1 },
    })
    expect(h.bot.blockAt({ ...grown, floored: () => grown } as never)?.name).toBe('oak_sapling')
    expect(h.bot.dug.filter((d) => d.name === 'oak_log')).toHaveLength(4)

    const tended = await call(h, 'tend_farm', { farm: 'oak wood', wait_seconds: 30 })

    expect(task(tended)).toMatchObject({
      status: 'succeeded',
      result: { components: [{ kind: 'grove', planted: 1 }] },
    })
    expect(h.bot.blockAt({ ...gone, floored: () => gone } as never)?.name).toBe('oak_sapling')
  })

  it('plants a ring around a house, unprotected, and refuses saplings it cannot place', async () => {
    const h = await start()

    const result = await call(h, 'plant_trees', {
      species: 'oak',
      count: 6,
      around: { from: at(10, GROUND, -5), to: at(12, GROUND, -3), distance: 3, depth: 6 },
      wait_seconds: 30,
    })

    expect(task(result)).toMatchObject({ status: 'succeeded', result: { planted: 6, protectedArea: false } })
    for (const p of h.bot.placed.filter((placed) => placed.name === 'oak_sapling'))
      expect(p.position.x >= 7 && p.position.x <= 15 && p.position.z >= -8 && p.position.z <= 0).toBe(false)
  })
})
