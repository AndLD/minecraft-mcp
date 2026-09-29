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

/** A flat dirt world with a small stair-and-planks build at x 12..14, the bot at (0, 64, 0), the owner to the east. */
async function start(setup: (bot: FakeBot) => void = () => undefined): Promise<Harness> {
  const bot = new FakeBot().useGameData()
  for (let x = -10; x <= 30; x += 1)
    for (let z = -10; z <= 30; z += 1) {
      bot.setBlock(at(x, GROUND - 1, z), 'dirt')
      bot.setBlock(at(x, GROUND, z), 'dirt')
      for (let y = FLOOR; y <= FLOOR + 5; y += 1) bot.setBlock(at(x, y, z), 'air')
    }
  for (const x of [12, 13, 14]) bot.setBlock(at(x, FLOOR, 5), 'oak_stairs')
  bot.entity = { position: at(0.5, FLOOR, 0.5) }
  bot.players['Andrey_Knight'] = {
    username: 'Andrey_Knight',
    entity: {
      id: 900,
      type: 'player',
      name: 'Andrey_Knight',
      position: at(16.5, FLOOR, 5.5),
      yaw: 0,
      pitch: 0,
    },
  }
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

describe('break_block through the MCP server', () => {
  it('breaks exactly the named stair and nothing beside it', async () => {
    const h = await start()

    const result = await call(h, 'break_block', { x: 13, y: FLOOR, z: 5, wait_seconds: 30 })

    expect(data(result)).toMatchObject({
      status: 'succeeded',
      result: { broken: true, block: 'oak_stairs', at: at(13, FLOOR, 5) },
    })
    expect(nameAt(h, at(13, FLOOR, 5))).toBe('air')
    expect(nameAt(h, at(12, FLOOR, 5))).toBe('oak_stairs')
    expect(nameAt(h, at(14, FLOOR, 5))).toBe('oak_stairs')
  })

  it('breaks the block the owner looks at', async () => {
    const h = await start()
    h.bot.rayHit = { name: 'oak_stairs', position: at(12, FLOOR, 5), face: 1 }

    const result = await call(h, 'break_block', { looking_at: true, wait_seconds: 30 })

    expect(data(result)).toMatchObject({ status: 'succeeded', result: { at: at(12, FLOOR, 5) } })
    expect(nameAt(h, at(12, FLOOR, 5))).toBe('air')
    expect(nameAt(h, at(13, FLOOR, 5))).toBe('oak_stairs')
  })

  it('refuses a protected block, and breaks that one block when the override is given', async () => {
    const h = await start()
    await h.call('protect_area', {
      label: 'House',
      x1: 11,
      y1: FLOOR - 2,
      z1: 3,
      x2: 15,
      y2: FLOOR + 4,
      z2: 7,
    })

    const refused = await call(h, 'break_block', { x: 13, y: FLOOR, z: 5, wait_seconds: 30 })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('protected_area')
    expect(refused.text).toContain('override_protection')
    expect(nameAt(h, at(13, FLOOR, 5))).toBe('oak_stairs')

    const forced = await call(h, 'break_block', {
      x: 13,
      y: FLOOR,
      z: 5,
      override_protection: true,
      wait_seconds: 30,
    })
    expect(data(forced)).toMatchObject({
      status: 'succeeded',
      result: { broken: true, overrodeProtection: 'House' },
    })
    expect(nameAt(h, at(13, FLOOR, 5))).toBe('air')
    expect(nameAt(h, at(12, FLOOR, 5))).toBe('oak_stairs')
    const areas = data(await h.call('list_protected_areas'))
    expect(JSON.stringify(areas)).toContain('House')
  })

  it('refuses a stone with lava behind it, and a chest unless containers are allowed', async () => {
    const h = await start((bot) => {
      bot.setBlock(at(6, FLOOR, 0), 'stone')
      bot.setBlock(at(7, FLOOR, 0), 'lava')
      bot.setBlock(at(6, FLOOR, 8), 'chest')
    })

    const lava = await call(h, 'break_block', { x: 6, y: FLOOR, z: 0, wait_seconds: 30 })
    expect(lava.isError).toBe(true)
    expect(lava.text).toContain('hit_lava')
    expect(nameAt(h, at(6, FLOOR, 0))).toBe('stone')

    const chest = await call(h, 'break_block', { x: 6, y: FLOOR, z: 8, wait_seconds: 30 })
    expect(chest.isError).toBe(true)
    expect(chest.text).toContain('holds_items')
    expect(nameAt(h, at(6, FLOOR, 8))).toBe('chest')

    const allowed = await call(h, 'break_block', {
      x: 6,
      y: FLOOR,
      z: 8,
      allow_containers: true,
      wait_seconds: 30,
    })
    expect(data(allowed)).toMatchObject({ status: 'succeeded', result: { block: 'chest' } })
  })

  it('says nothing needed doing for an empty cell', async () => {
    const h = await start()

    const result = await call(h, 'break_block', { x: 5, y: FLOOR + 2, z: 5, wait_seconds: 30 })

    expect(data(result)).toMatchObject({
      status: 'succeeded',
      result: { broken: false, block: 'air' },
    })
  })
})
