import { afterEach, describe, expect, it } from '@jest/globals'
import { toVec3 } from '../../src/bot/vec3.js'
import { FakeBot } from '../fakes/fake-bot.js'
import { createHarness, type Harness } from './support/app-harness.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close().catch(() => undefined)
  harness = undefined
})

const at = (x: number, y: number, z: number) => ({ x, y, z })

/** Flat dirt ground at y = 63, air above; the bot stands on the surface at (0, 64, 0). */
async function start(setup: (bot: FakeBot) => void = () => undefined): Promise<Harness> {
  const bot = new FakeBot().useGameData()
  for (let x = -5; x <= 15; x += 1)
    for (let z = -5; z <= 15; z += 1) {
      bot.setBlock({ x, y: 63, z }, 'dirt')
      for (let y = 64; y <= 68; y += 1) bot.setBlock({ x, y, z }, 'air')
    }
  bot.entity = { position: at(0.5, 64, 0.5) }
  bot.physics = true
  bot.addItems('wooden_hoe', 1)
  setup(bot)
  const h = await createHarness({}, { bot })
  harness = h
  bot.now = () => h.clock.now()
  const connected = await h.call('connect', { port: 34231 })
  if (connected.isError) throw new Error(connected.text)
  await h.call('wait_for_chat', { timeout_seconds: 1 })
  return h
}

/** Runs a call, pumping the fake scheduler until it settles (for background tasks). */
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
const task = (result: { data: unknown }): Record<string, unknown> =>
  result.data as Record<string, unknown>
const nameAt = (h: Harness, x: number, y: number, z: number): string | undefined =>
  h.bot.blockAt(toVec3(at(x, y, z)))?.name

describe('farming through the MCP server', () => {
  it('builds a watered, tilled, planted field and registers it', async () => {
    const h = await start((bot) => {
      bot.addItems('wheat_seeds', 8)
      bot.addItems('water_bucket', 1)
    })

    const result = await call(h, 'build_farm', {
      kind: 'field',
      params: { width: 3, length: 3, crop: 'wheat', fence: false, torches: false },
      origin: { x: 0, y: 63, z: 0 },
      label: 'wheat field',
      wait_seconds: 30,
    })

    expect(task(result)).toMatchObject({
      status: 'succeeded',
      result: { kind: 'wheat field 3x3', farm: { kind: 'field', crop: 'wheat', label: 'wheat field' } },
    })
    expect(nameAt(h, 0, 63, 0)).toBe('farmland')
    expect(nameAt(h, 0, 64, 0)).toBe('wheat')
    expect(nameAt(h, 1, 63, 0)).toBe('water') // the channel cell (centre column, x0+1)

    const list = await h.call('list_farms')
    expect(task(list)).toMatchObject({ count: 1, farms: [{ label: 'wheat field', crop: 'wheat' }] })
  })

  it('harvests only fully grown crops and replants, reported by inspect_farm before and after', async () => {
    const h = await start((bot) => {
      // A tiny hand-built field: two farmland plots with wheat, one ripe, one not, no channel or fence.
      bot.setBlock({ x: 0, y: 63, z: 0 }, 'farmland')
      bot.setBlock({ x: 0, y: 64, z: 0 }, 'wheat')
      bot.setCropAge({ x: 0, y: 64, z: 0 }, 7)
      bot.setBlock({ x: 1, y: 63, z: 0 }, 'farmland')
      bot.setBlock({ x: 1, y: 64, z: 0 }, 'wheat')
      bot.setCropAge({ x: 1, y: 64, z: 0 }, 2)
      bot.addItems('wheat_seeds', 5)
    })
    const registered = await h.call('register_farm', {
      kind: 'field',
      crop: 'wheat',
      from: { x: 0, y: 63, z: 0 },
      to: { x: 1, y: 63, z: 0 },
      label: 'wheat field',
    })
    expect(registered.isError).toBe(false)

    const before = await h.call('inspect_farm', { farm: 'wheat field' })
    expect(task(before)).toMatchObject({ components: [{ ripe: 1, growing: 1, empty: 0 }] })

    const harvest = await call(h, 'harvest_crops', { farm: 'wheat field', wait_seconds: 30 })

    expect(task(harvest)).toMatchObject({ status: 'succeeded', result: { harvested: 1, replanted: 1 } })
    expect(nameAt(h, 0, 64, 0)).toBe('wheat') // replanted
    expect(h.bot.blockAt(toVec3({ x: 0, y: 64, z: 0 }))?.getProperties?.()['age']).toBe('0')

    const after = await h.call('inspect_farm', { farm: 'wheat field' })
    expect(task(after)).toMatchObject({ components: [{ ripe: 0, growing: 2, empty: 0 }] })
  })

  it('tend_farm runs harvest, replant, and planting for a whole field in one pass', async () => {
    const h = await start((bot) => {
      bot.setBlock({ x: 0, y: 63, z: 0 }, 'farmland')
      bot.setBlock({ x: 0, y: 64, z: 0 }, 'wheat')
      bot.setCropAge({ x: 0, y: 64, z: 0 }, 7)
      bot.setBlock({ x: 1, y: 63, z: 0 }, 'farmland') // empty plot: nothing planted yet
      bot.addItems('wheat_seeds', 5)
    })
    const registered = await h.call('register_farm', {
      kind: 'field',
      crop: 'wheat',
      from: { x: 0, y: 63, z: 0 },
      to: { x: 1, y: 63, z: 0 },
      label: 'wheat field',
    })
    expect(registered.isError).toBe(false)

    const result = await call(h, 'tend_farm', { farm: 'wheat field', wait_seconds: 30 })

    expect(task(result)).toMatchObject({
      status: 'succeeded',
      result: { components: [{ kind: 'field', harvested: 1, replanted: 1, planted: 1 }] },
    })
    expect(nameAt(h, 0, 64, 0)).toBe('wheat')
    expect(nameAt(h, 1, 64, 0)).toBe('wheat')
  })
})
