import { afterEach, describe, expect, it } from '@jest/globals'
import { toVec3 } from '../../src/bot/vec3.js'
import { FakeBot } from '../fakes/fake-bot.js'
import { createHarness, type Harness } from './support/app-harness.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close().catch(() => undefined)
  harness = undefined
})

type Cell = { x: number; y: number; z: number }
const at = (x: number, y: number, z: number): Cell => ({ x, y, z })
const GROUND = 63
const FLOOR = GROUND + 1

/** A flat dirt world; the bot stands at (0, 64, 0) with two empty buckets. */
async function start(setup: (bot: FakeBot) => void = () => undefined): Promise<Harness> {
  const bot = new FakeBot().useGameData()
  for (let x = -12; x <= 30; x += 1)
    for (let z = -12; z <= 30; z += 1) {
      bot.setBlock(at(x, GROUND - 1, z), 'dirt')
      bot.setBlock(at(x, GROUND, z), 'dirt')
      for (let y = FLOOR; y <= FLOOR + 5; y += 1) bot.setBlock(at(x, y, z), 'air')
    }
  bot.entity = { position: at(0.5, FLOOR, 0.5) }
  bot.addItems('bucket', 2)
  setup(bot)
  const h = await createHarness({}, { bot })
  harness = h
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
const data = (result: { data: unknown }): Record<string, unknown> =>
  result.data as Record<string, unknown>
const nameAt = (h: Harness, cell: Cell): string | undefined => h.bot.blockAt(toVec3(cell))?.name

describe('fill_bucket through the MCP server', () => {
  it('fills a bucket from a pond whose sources meet on two sides and the pond stays', async () => {
    const h = await start((bot) => {
      for (const [x, z] of [
        [8, 4],
        [9, 4],
        [8, 5],
        [9, 5],
      ] as const)
        bot.setBlock(at(x, GROUND, z), 'water')
    })

    const result = await call(h, 'fill_bucket', { liquid: 'water', wait_seconds: 30 })

    expect(data(result)).toMatchObject({
      status: 'succeeded',
      result: { liquid: 'water', item: 'water_bucket', filled: 1, poolRefills: true },
    })
    expect(h.bot.count('water_bucket')).toBe(1)
    expect(h.bot.count('bucket')).toBe(1)
    for (const [x, z] of [
      [8, 4],
      [9, 4],
      [8, 5],
      [9, 5],
    ] as const)
      expect(nameAt(h, at(x, GROUND, z))).toBe('water')
  })

  it('drains a single source, and does not fill from flowing water', async () => {
    const h = await start((bot) => {
      bot.setBlock(at(5, GROUND, 0), 'water')
      bot.setLiquidLevel(at(5, GROUND, 0), 2)
      bot.setBlock(at(9, GROUND, 0), 'water')
    })

    const result = await call(h, 'fill_bucket', { liquid: 'water', wait_seconds: 30 })

    expect(data(result)).toMatchObject({
      status: 'succeeded',
      result: { filled: 1, from: [at(9, GROUND, 0)], poolRefills: false },
    })
    expect(nameAt(h, at(9, GROUND, 0))).toBe('air')
    expect(nameAt(h, at(5, GROUND, 0))).toBe('water')
  })

  it('takes lava from a pool without standing beside it', async () => {
    const h = await start((bot) => {
      for (let x = 8; x <= 10; x += 1)
        for (let z = -1; z <= 1; z += 1) bot.setBlock(at(x, GROUND, z), 'lava')
    })

    const result = await call(h, 'fill_bucket', { liquid: 'lava', wait_seconds: 30 })

    expect(data(result)).toMatchObject({ status: 'succeeded', result: { item: 'lava_bucket' } })
    expect(h.bot.count('lava_bucket')).toBe(1)
    // Nothing is left beside the bot but ground.
    const feet = h.bot.entity?.position ?? at(0, 0, 0)
    for (let dx = -1; dx <= 1; dx += 1)
      for (let dz = -1; dz <= 1; dz += 1)
        expect(
          nameAt(h, at(Math.floor(feet.x) + dx, Math.floor(feet.y), Math.floor(feet.z) + dz)),
        ).not.toBe('lava')
  })

  it('refuses lava beside a player build and takes it once the block is named', async () => {
    const h = await start((bot) => {
      bot.setBlock(at(8, GROUND, 0), 'lava')
      bot.setBlock(at(8, FLOOR, 3), 'oak_planks')
    })

    const refused = await call(h, 'fill_bucket', { liquid: 'lava', wait_seconds: 30 })
    const named = await call(h, 'fill_bucket', {
      liquid: 'lava',
      at: at(8, GROUND, 0),
      wait_seconds: 30,
    })

    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('structure_nearby')
    expect(data(named)).toMatchObject({ status: 'succeeded', result: { item: 'lava_bucket' } })
  })

  it('refuses lava inside a protected area', async () => {
    const h = await start((bot) => {
      bot.setBlock(at(8, GROUND, 0), 'lava')
    })
    await h.call('protect_area', {
      label: 'Portal room',
      x1: 5,
      y1: GROUND - 3,
      z1: -5,
      x2: 12,
      y2: GROUND + 5,
      z2: 5,
    })

    const result = await call(h, 'fill_bucket', { liquid: 'lava', wait_seconds: 30 })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('protected_area')
    expect(h.bot.count('lava_bucket')).toBe(0)
  })

  it('says what to craft when no empty bucket is carried', async () => {
    const h = await start((bot) => {
      bot.removeItems('bucket', 2)
      bot.setBlock(at(4, GROUND, 0), 'water')
    })

    const result = await call(h, 'fill_bucket', { liquid: 'water', wait_seconds: 30 })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('no_bucket')
    expect(result.text).toContain('3 iron ingots')
  })
})
