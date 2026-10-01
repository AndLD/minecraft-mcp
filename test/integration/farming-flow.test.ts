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
      bot.addItems('water_bucket', 3)
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
      result: {
        kind: 'wheat field 3x3',
        farm: { kind: 'field', crop: 'wheat', label: 'wheat field' },
      },
    })
    expect(nameAt(h, 0, 63, 0)).toBe('farmland')
    expect(nameAt(h, 0, 64, 0)).toBe('wheat')
    // The trench: the whole centre column (x0 + 1), so every row is watered.
    for (const z of [0, 1, 2]) expect(nameAt(h, 1, 63, z)).toBe('water')

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

    expect(task(harvest)).toMatchObject({
      status: 'succeeded',
      result: { harvested: 1, replanted: 1 },
    })
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
  it('builds a field with separate water blocks: one at the centre of a 7x7 field, none at an edge', async () => {
    const h = await start((bot) => {
      bot.addItems('wheat_seeds', 60)
      bot.addItems('water_bucket', 1)
    })

    const result = await call(h, 'build_farm', {
      kind: 'field',
      params: { width: 7, length: 7, crop: 'wheat', fence: false, torches: false, water: 'spots' },
      origin: { x: 0, y: 63, z: 0 },
      wait_seconds: 30,
    })

    expect(task(result)).toMatchObject({ status: 'succeeded', result: { planted: 48 } })
    let water = 0
    for (let x = 0; x < 7; x += 1)
      for (let z = 0; z < 7; z += 1) if (nameAt(h, x, 63, z) === 'water') water += 1
    expect(water).toBe(1)
    expect(nameAt(h, 3, 63, 3)).toBe('water')
  })

  it('fences the field with a gate in line with the fence, and previews the water buckets it needs', async () => {
    const h = await start((bot) => {
      bot.addItems('wheat_seeds', 10)
      bot.addItems('water_bucket', 1)
      bot.addItems('oak_fence', 20)
      bot.addItems('oak_fence_gate', 1)
    })
    const params = {
      width: 3,
      length: 3,
      crop: 'wheat',
      fence: true,
      torches: false,
      water: 'spots',
    }

    const preview = await h.call('build_farm', {
      kind: 'field',
      params,
      origin: at(0, 63, 0),
      preview: true,
    })
    expect(preview.isError).toBe(false)
    expect(JSON.stringify(preview.data)).toContain('water_bucket')

    const result = await call(h, 'build_farm', {
      kind: 'field',
      params,
      origin: at(0, 63, 0),
      wait_seconds: 30,
    })

    expect(task(result)).toMatchObject({ status: 'succeeded' })
    // The gate is in the south side (z = 3), which runs along x: it faces north or south, never east or west.
    expect(nameAt(h, 1, 64, 3)).toBe('oak_fence_gate')
    const facing = h.bot.blockAt(toVec3(at(1, 64, 3)))?.getProperties?.()['facing']
    expect(['north', 'south']).toContain(facing)
  })
  describe.each([
    ['north', at(1, 64, -1), ['north', 'south']],
    ['south', at(1, 64, 3), ['north', 'south']],
    ['east', at(3, 64, 1), ['east', 'west']],
    ['west', at(-1, 64, 1), ['east', 'west']],
  ] as const)('a field with the gate on the %s side', (side, gate, facings) => {
    it('builds the gate there, in line with the fence, and remembers the side', async () => {
      const h = await start((bot) => {
        bot.addItems('wheat_seeds', 10)
        bot.addItems('water_bucket', 1)
        bot.addItems('oak_fence', 20)
        bot.addItems('oak_fence_gate', 1)
      })

      const result = await call(h, 'build_farm', {
        kind: 'field',
        params: {
          width: 3,
          length: 3,
          crop: 'wheat',
          fence: true,
          torches: false,
          water: 'spots',
          gate_side: side,
        },
        origin: at(0, 63, 0),
        label: 'gated field',
        wait_seconds: 30,
      })

      expect(task(result)).toMatchObject({
        status: 'succeeded',
        result: { farm: { gateSide: side } },
      })
      expect(nameAt(h, gate.x, gate.y, gate.z)).toBe('oak_fence_gate')
      const facing = h.bot.blockAt(toVec3(gate))?.getProperties?.()['facing']
      expect(facings).toContain(facing)
      const list = await h.call('list_farms')
      expect(task(list)).toMatchObject({ farms: [{ label: 'gated field', gateSide: side }] })
    })
  })

  it('builds a pumpkin field: stems in every second row, the rows between left free', async () => {
    const h = await start((bot) => {
      bot.addItems('pumpkin_seeds', 8)
      bot.addItems('water_bucket', 3)
    })

    const result = await call(h, 'build_farm', {
      kind: 'field',
      params: { width: 3, length: 3, crop: 'pumpkin', fence: false, torches: false },
      origin: at(0, 63, 0),
      label: 'pumpkins',
      wait_seconds: 30,
    })

    expect(task(result)).toMatchObject({
      status: 'succeeded',
      result: { planted: 4, farm: { crop: 'pumpkin' } },
    })
    for (const z of [0, 2])
      for (const x of [0, 2]) {
        expect(nameAt(h, x, 63, z)).toBe('farmland')
        expect(nameAt(h, x, 64, z)).toBe('pumpkin_stem')
      }
    // The free row: untouched ground beside the stems (the water trench crosses it in the middle), air above.
    for (const x of [0, 2]) expect(nameAt(h, x, 63, 1)).toBe('dirt')
    expect(nameAt(h, 1, 63, 1)).toBe('water')
    for (const x of [0, 1, 2]) expect(nameAt(h, x, 64, 1)).toBe('air')
  })

  it('harvests a grown pumpkin and leaves the stem standing', async () => {
    const h = await start((bot) => {
      for (const z of [0, 2]) {
        bot.setBlock({ x: 0, y: 63, z }, 'farmland')
        bot.setBlock({ x: 0, y: 64, z }, 'pumpkin_stem')
        bot.setCropAge({ x: 0, y: 64, z }, 7)
      }
      bot.setBlock({ x: 0, y: 64, z: 1 }, 'pumpkin')
      bot.addItems('pumpkin_seeds', 5)
    })
    const registered = await h.call('register_farm', {
      kind: 'field',
      crop: 'pumpkin',
      from: at(0, 63, 0),
      to: at(0, 63, 2),
      label: 'pumpkins',
    })
    expect(registered.isError).toBe(false)
    const before = await h.call('inspect_farm', { farm: 'pumpkins' })
    expect(task(before)).toMatchObject({ components: [{ ripe: 1, growing: 2 }] })

    const harvest = await call(h, 'harvest_crops', { farm: 'pumpkins', wait_seconds: 30 })

    expect(task(harvest)).toMatchObject({
      status: 'succeeded',
      result: { harvested: 1, replanted: 0 },
    })
    expect(nameAt(h, 0, 64, 1)).toBe('air')
    expect(nameAt(h, 0, 64, 0)).toBe('pumpkin_stem')
    expect(nameAt(h, 0, 64, 2)).toBe('pumpkin_stem')
    const after = await h.call('inspect_farm', { farm: 'pumpkins' })
    expect(task(after)).toMatchObject({ components: [{ ripe: 0, growing: 2 }] })
  })

  it('fertilizes a field on ask: unripe wheat is ripened with bone meal, the ripe plant is left, and harvest takes all of it', async () => {
    const h = await start((bot) => {
      for (const [x, age] of [
        [0, 7],
        [1, 0],
        [2, 3],
      ] as const) {
        bot.setBlock({ x, y: 63, z: 0 }, 'farmland')
        bot.setBlock({ x, y: 64, z: 0 }, 'wheat')
        bot.setCropAge({ x, y: 64, z: 0 }, age)
      }
      bot.addItems('bone_meal', 10)
    })
    const registered = await h.call('register_farm', {
      kind: 'field',
      crop: 'wheat',
      from: { x: 0, y: 63, z: 0 },
      to: { x: 2, y: 63, z: 0 },
      label: 'wheat field',
    })
    expect(registered.isError).toBe(false)

    const fertilized = await call(h, 'fertilize_crops', { farm: 'wheat field', wait_seconds: 30 })

    expect(task(fertilized)).toMatchObject({
      status: 'succeeded',
      result: { applied: 6, ripened: 2, boneMealLeft: 4, skipped: { alreadyRipe: 1 } },
    })
    const after = await h.call('inspect_farm', { farm: 'wheat field' })
    expect(task(after)).toMatchObject({ components: [{ ripe: 3, growing: 0 }] })
    const harvest = await call(h, 'harvest_crops', { farm: 'wheat field', wait_seconds: 30 })
    expect(task(harvest)).toMatchObject({ status: 'succeeded', result: { harvested: 3 } })
  })

  it('fails missing_bone_meal, saying what is needed, when the bag has none', async () => {
    const h = await start((bot) => {
      bot.setBlock({ x: 0, y: 63, z: 0 }, 'farmland')
      bot.setBlock({ x: 0, y: 64, z: 0 }, 'wheat')
    })

    const result = await call(h, 'fertilize_crops', {
      area: { from: { x: 0, y: 63, z: 0 }, to: { x: 0, y: 63, z: 0 } },
      wait_seconds: 30,
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('missing_bone_meal')
  })

  it('composts scraps in a composter beside the bot and takes the bone meal out', async () => {
    const h = await start((bot) => {
      bot.setBlock({ x: 3, y: 64, z: 0 }, 'composter')
      bot.addItems('wheat_seeds', 10)
    })

    const result = await call(h, 'use_composter', { wait_seconds: 30 })

    expect(task(result)).toMatchObject({
      status: 'succeeded',
      result: { composted: [{ name: 'wheat_seeds', count: 7 }], level: 0 },
    })
    expect(h.bot.count('wheat_seeds')).toBe(3)
  })

  it('builds an apiary: a hive on a campfire for each of two hives, a row of flowers, registered as kind "apiary"', async () => {
    const h = await start((bot) => {
      bot.addItems('beehive', 2)
      bot.addItems('campfire', 2)
      bot.addItems('poppy', 10)
    })

    const result = await call(h, 'build_farm', {
      kind: 'apiary',
      params: { hives: 2 },
      origin: { x: 2, y: 63, z: 0 },
      label: 'bees',
      wait_seconds: 30,
    })

    expect(task(result)).toMatchObject({
      status: 'succeeded',
      result: { farm: { kind: 'apiary', species: 'bee' } },
    })
    for (const x of [2, 5]) {
      expect(nameAt(h, x, 64, 0)).toBe('campfire')
      expect(nameAt(h, x, 65, 0)).toBe('beehive')
    }
  })

  it('tend_farm takes the honey of a ripe hive in an apiary, smoked, and inspect_farm reads it before and after', async () => {
    const h = await start((bot) => {
      bot.setBlock({ x: 3, y: 64, z: 0 }, 'campfire')
      bot.setBlock({ x: 3, y: 65, z: 0 }, 'beehive')
      bot.setHoneyLevel({ x: 3, y: 65, z: 0 }, 5)
      bot.setBlock({ x: 6, y: 64, z: 0 }, 'campfire')
      bot.setBlock({ x: 6, y: 65, z: 0 }, 'beehive')
      bot.setHoneyLevel({ x: 6, y: 65, z: 0 }, 2)
      bot.addItems('glass_bottle', 3)
    })
    const registered = await h.call('register_farm', {
      kind: 'apiary',
      species: 'bee',
      from: { x: 2, y: 64, z: -1 },
      to: { x: 7, y: 65, z: 1 },
      label: 'bees',
    })
    expect(registered.isError).toBe(false)
    const before = await h.call('inspect_farm', { farm: 'bees' })
    expect(task(before)).toMatchObject({
      components: [{ kind: 'apiary', ripe: 1, growing: 1, empty: 0 }],
    })

    const tended = await call(h, 'tend_farm', { farm: 'bees', wait_seconds: 30 })

    expect(task(tended)).toMatchObject({
      status: 'succeeded',
      result: { components: [{ kind: 'apiary', honeyBottles: 1 }] },
    })
    expect(h.bot.count('honey_bottle')).toBe(1)
    const after = await h.call('inspect_farm', { farm: 'bees' })
    expect(task(after)).toMatchObject({ components: [{ ripe: 0, growing: 1, empty: 1 }] })
  })

  it('harvest_honey refuses a hive with no smoke, and inspect_hives says why', async () => {
    const h = await start((bot) => {
      bot.setBlock({ x: 3, y: 65, z: 0 }, 'beehive')
      bot.setHoneyLevel({ x: 3, y: 65, z: 0 }, 5)
      bot.addItems('glass_bottle', 1)
    })

    const seen = await h.call('inspect_hives', {})
    expect(task(seen)).toMatchObject({
      ready: 1,
      hives: [{ honeyLevel: 5, ready: true, smoked: false }],
    })

    const refused = await call(h, 'harvest_honey', { wait_seconds: 30 })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('no_smoke')
    expect(h.bot.count('honey_bottle')).toBe(0)

    const told = await call(h, 'harvest_honey', { smoke: 'never', wait_seconds: 30 })
    expect(task(told)).toMatchObject({ status: 'succeeded', result: { honeyBottles: 1 } })
  })
})
