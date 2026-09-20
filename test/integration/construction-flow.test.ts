import { afterEach, describe, expect, it } from '@jest/globals'
import { toVec3 } from '../../src/bot/vec3.js'
import { FakeBot } from '../fakes/fake-bot.js'
import { createHarness, type Harness } from './support/app-harness.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close().catch(() => undefined)
  harness = undefined
})

const HERE = { x: 10, y: 64, z: -5 }
const at = (x: number, y: number, z: number) => ({ x, y, z })

async function start(setup: (bot: FakeBot) => void = () => undefined): Promise<Harness> {
  const bot = new FakeBot().useGameData()
  for (let x = HERE.x - 20; x <= HERE.x + 30; x += 1)
    for (let z = HERE.z - 20; z <= HERE.z + 30; z += 1) {
      bot.setBlock({ x, y: 62, z }, 'dirt')
      bot.setBlock({ x, y: 63, z }, 'dirt')
      for (let y = 64; y <= 72; y += 1) bot.setBlock({ x, y, z }, 'air')
    }
  setup(bot)
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
const task = (result: { data: unknown }): Record<string, unknown> =>
  result.data as Record<string, unknown>
const nameAt = (h: Harness, x: number, y: number, z: number): string | undefined =>
  h.bot.blockAt(toVec3(at(x, y, z)))?.name

describe('building through the MCP server', () => {
  it('lists the blueprints with their parameters', async () => {
    const h = await start()

    const listed = await h.call('list_blueprints')

    const names = (listed.data as { blueprints: { name: string }[] }).blueprints.map((b) => b.name)
    expect(names).toEqual(['block', 'box', 'custom', 'floor', 'house', 'shelter', 'solid', 'walls'])
  })

  it('previews a build: origin, materials, and what is missing, without changing anything', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [{ name: 'cobblestone', count: 30 }]
    })

    const preview = await h.call('preview_build', {
      blueprint: 'box',
      params: { width: 4, depth: 4, height: 2 },
    })

    expect(preview.data).toMatchObject({
      blueprint: 'box 4x4x2',
      origin: { x: 12, y: 64, z: -5 },
      defaultOrigin: true,
      toPlace: 54,
      missing: [{ name: 'cobblestone', count: 24 }],
      bounds: { from: { x: 12, y: 64, z: -5 }, to: { x: 15, y: 67, z: -2 } },
    })
    expect(h.bot.placed).toEqual([])
  })

  it('builds a closed box from the inventory', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [{ name: 'cobblestone', count: 70 }]
    })

    const result = await call(h, 'build', {
      blueprint: 'box',
      params: { width: 4, depth: 4, height: 2 },
      origin: { x: 20, y: 64, z: 0 },
      wait_seconds: 55,
    })

    expect(task(result)).toMatchObject({ status: 'succeeded', result: { placed: 54, broken: 0 } })
    expect(h.bot.placed).toHaveLength(54)
    expect(nameAt(h, 20, 64, 0)).toBe('cobblestone') // floor corner
    expect(nameAt(h, 23, 66, 3)).toBe('cobblestone') // wall corner
    expect(nameAt(h, 21, 66, 1)).toBe('air') // the room is hollow
    expect(nameAt(h, 21, 67, 1)).toBe('cobblestone') // roof
    expect(nameAt(h, 22, 65, 0)).toBe('air') // the doorway
    expect(nameAt(h, 22, 66, 0)).toBe('air')
    expect(nameAt(h, 22, 67, 0)).toBe('cobblestone') // the wall above it
    expect(h.bot.count('cobblestone')).toBe(16)
  })

  it('refuses a build that lacks materials, naming them, and changes nothing', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [{ name: 'cobblestone', count: 10 }]
    })

    const result = await call(h, 'build', {
      blueprint: 'floor',
      params: { width: 5, depth: 5 },
      origin: { x: 20, y: 64, z: 0 },
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('missing_materials')
    expect(result.text).toContain('15 cobblestone')
    expect(result.text).toContain('gather, craft, or hunt')
    expect(h.bot.placed).toEqual([])
  })

  it('fetches the missing materials from a chest, then builds', async () => {
    const h = await start((bot) => {
      bot.setBlock(at(12, 64, -5), 'chest')
      bot.stock(at(12, 64, -5), 'cobblestone', 30)
      bot.inventoryItems = [{ name: 'cobblestone', count: 10 }]
    })
    await h.call('register_container', { x: 12, y: 64, z: -5, label: 'stone' })
    await call(h, 'scan_containers', { wait_seconds: 30 })

    const result = await call(h, 'build', {
      blueprint: 'floor',
      params: { width: 5, depth: 5 },
      origin: { x: 20, y: 64, z: 0 },
      wait_seconds: 55,
    })

    expect(task(result)).toMatchObject({
      status: 'succeeded',
      result: { placed: 25, fetched: [{ name: 'cobblestone', count: 15 }] },
    })
    expect(h.bot.inContainer(at(12, 64, -5), 'cobblestone')).toBe(15)
  })

  it('never builds into a protected area', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [{ name: 'cobblestone', count: 30 }]
    })
    await h.call('protect_area', {
      label: 'village',
      x1: 18,
      y1: 60,
      z1: -2,
      x2: 30,
      y2: 80,
      z2: 6,
    })

    const result = await call(h, 'build', {
      blueprint: 'floor',
      params: { width: 3, depth: 3 },
      origin: { x: 20, y: 64, z: 0 },
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('protected_area')
    expect(result.text).toContain('village')
    expect(h.bot.placed).toEqual([])
  })

  it('refuses a site next to lava', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [{ name: 'cobblestone', count: 30 }]
      bot.setBlock(at(23, 64, 1), 'lava')
    })

    const result = await call(h, 'build', {
      blueprint: 'floor',
      params: { width: 3, depth: 3 },
      origin: { x: 20, y: 64, z: 0 },
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('unsafe_site')
  })

  it('names blocked cells, and clears them when allowed', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [{ name: 'cobblestone', count: 30 }]
      bot.setBlock(at(21, 64, 1), 'dirt')
    })
    const args = {
      blueprint: 'floor',
      params: { width: 3, depth: 3 },
      origin: { x: 20, y: 64, z: 0 },
    }

    const refused = await call(h, 'build', args)
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('blocked_cells')
    expect(refused.text).toContain('21, 64, 1')

    const cleared = await call(h, 'build', { ...args, clear_obstacles: true, wait_seconds: 55 })
    expect(task(cleared)).toMatchObject({ status: 'succeeded', result: { placed: 9, broken: 1 } })
  })

  it('runs again to finish what is missing', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [{ name: 'cobblestone', count: 30 }]
    })
    const args = {
      blueprint: 'floor',
      params: { width: 3, depth: 3 },
      origin: { x: 20, y: 64, z: 0 },
      wait_seconds: 55,
    }
    await call(h, 'build', args)
    h.bot.setBlock(at(21, 64, 1), 'air')

    const again = await call(h, 'build', args)

    expect(task(again)).toMatchObject({
      status: 'succeeded',
      result: { placed: 1, alreadyDone: 8 },
    })
  })

  it('places a single block at coordinates', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [{ name: 'oak_planks', count: 2 }]
    })

    const result = await call(h, 'place_block', {
      block: 'oak_planks',
      x: 20,
      y: 64,
      z: 0,
      wait_seconds: 30,
    })

    expect(task(result)).toMatchObject({ status: 'succeeded', result: { placed: 1 } })
    expect(nameAt(h, 20, 64, 0)).toBe('oak_planks')
  })

  it('reports wrong parameters and unknown blueprints in words', async () => {
    const h = await start()

    const wrong = await call(h, 'build', { blueprint: 'box', params: { width: 4 } })
    const unknown = await call(h, 'build', { blueprint: 'castle' })

    expect(wrong.text).toContain('invalid_params')
    expect(wrong.text).toContain('depth')
    expect(unknown.text).toContain('unknown_blueprint')
    expect(unknown.text).toContain('box')
  })
})
