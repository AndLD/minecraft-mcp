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

function flatFloor(bot: FakeBot): void {
  for (let x = -20; x <= 60; x += 1) {
    for (let z = -30; z <= 20; z += 1) {
      bot.setBlock(at(x, GROUND, z), 'dirt')
      for (let y = GROUND + 1; y <= GROUND + 45; y += 1) bot.setBlock(at(x, y, z), 'air')
    }
  }
}

async function start(setup: (bot: FakeBot) => void = () => undefined, stocked = true): Promise<Harness> {
  const bot = new FakeBot().useGameData()
  flatFloor(bot)
  bot.entity = { position: at(10.5, GROUND + 1, -5.5) }
  bot.physics = true
  if (stocked) {
    bot.addItems('rail', 40)
    bot.addItems('powered_rail', 20)
    bot.addItems('redstone_torch', 12)
    bot.addItems('cobblestone', 30)
    bot.addItems('minecart', 1)
    bot.addItems('iron_pickaxe', 1)
    bot.addItems('torch', 10)
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
const data = (result: { data: unknown }): Record<string, unknown> => result.data as Record<string, unknown>

const END = at(30, GROUND + 1, -6)

describe('railways through the MCP server', () => {
  it('plans a flat line without changing anything', async () => {
    const h = await start()

    const plan = data(await h.call('plan_railway', { to: END }))

    expect(plan).toMatchObject({
      rails: 21,
      layout: 'surface',
      variant: 'economy',
      start: at(10, GROUND + 1, -6),
      end: END,
      poweredRails: 6,
      torches: 3,
      cuts: 0,
      decks: 0,
      missing: [],
    })
    expect(h.bot.placed).toEqual([])
  })

  it('builds it: rails, powered rails, torches, a buffer, then checks every rail', async () => {
    const h = await start()

    const built = await call(h, 'build_railway', { to: END, label: 'flat line', wait_seconds: 30 })

    expect(data(built)).toMatchObject({
      status: 'succeeded',
      result: { rails: 21, verification: { checked: 21, problems: [] }, id: 'railway-1' },
    })
    const laid = (name: string) => h.bot.placed.filter((p) => p.name === name)
    expect(laid('rail')).toHaveLength(15)
    expect(laid('powered_rail').map((p) => p.position.x)).toEqual(expect.arrayContaining([10, 11, 12, 13, 21, 29]))
    expect(laid('redstone_torch')).toHaveLength(3)
    expect(laid('cobblestone')).toEqual([{ name: 'cobblestone', position: at(9, GROUND + 1, -6) }])
  })

  it('puts a minecart on the start of the line it built', async () => {
    const h = await start()
    await call(h, 'build_railway', { to: END, wait_seconds: 30 })

    const placed = await call(h, 'place_minecart', { wait_seconds: 30 })

    expect(data(placed)).toMatchObject({ status: 'succeeded', result: { at: at(10, GROUND + 1, -6), line: 'railway-1' } })
    expect(h.bot.minecartsPlaced).toEqual([at(10, GROUND + 1, -6)])
  })

  it('goes around a wall with curves, and the corners check out', async () => {
    const h = await start((bot) => {
      for (let z = -12; z <= -3; z += 1) for (const y of [GROUND + 1, GROUND + 2]) bot.setBlock(at(20, y, z), 'stone_bricks')
    })

    const built = await call(h, 'build_railway', { to: END, wait_seconds: 30 })

    const result = data(built).result as { corners: unknown[]; verification: { problems: unknown[] } }
    expect(data(built)).toMatchObject({ status: 'succeeded' })
    expect(result.corners.length).toBeGreaterThanOrEqual(2)
    expect(result.verification.problems).toEqual([])
    expect(h.bot.dug).toEqual([]) // nothing of the wall was touched
  })

  it('cuts through a hill and lights the tunnel', async () => {
    const h = await start((bot) => {
      // Solid ground below the floor, so a tunnel has something to run through.
      for (let x = -20; x <= 60; x += 1)
        for (let z = -30; z <= 20; z += 1) for (let y = GROUND - 12; y < GROUND; y += 1) bot.setBlock(at(x, y, z), 'stone')
      for (let x = 15; x <= 25; x += 1)
        for (let z = -12; z <= 0; z += 1)
          for (let y = GROUND - 12; y <= GROUND + 8; y += 1) {
            if (y > GROUND) bot.setBlock(at(x, y, z), 'stone')
            bot.setLight(at(x, y, z), 0) // dark inside the hill
          }
    })

    const built = await call(h, 'build_railway', { to: END, layout: 'underground', depth: 3, wait_seconds: 30 })

    if (built.isError) throw new Error(built.text)
    expect(data(built)).toMatchObject({ status: 'succeeded', result: { layout: 'underground', verification: { problems: [] } } })
    expect((data(built).result as { cuts: number }).cuts).toBeGreaterThan(10)
    expect(h.bot.dug.length).toBeGreaterThan(10)
    expect(h.bot.placed.some((p) => p.name === 'torch')).toBe(true)
  })

  it('says what to craft when the rails are not there', async () => {
    const h = await start(() => undefined, false)

    const plan = data(await h.call('plan_railway', { to: END }))
    const built = await call(h, 'build_railway', { to: END, fetch_from_storage: false, wait_seconds: 30 })

    expect((plan.crafting as { name: string }[]).map((c) => c.name)).toEqual(
      expect.arrayContaining(['iron_ingot', 'gold_ingot', 'redstone', 'stick']),
    )
    expect(built.isError).toBe(true)
    expect(built.text).toContain('missing_materials')
    expect(built.text).toContain('iron_ingot')
  })

  it('explains a route it cannot find', async () => {
    const h = await start((bot) => {
      for (let z = -30; z <= 20; z += 1) bot.setBlock(at(20, GROUND, z), 'lava')
    })

    const plan = await h.call('plan_railway', { to: END })

    expect(plan.isError).toBe(true)
    expect(plan.text).toContain('no_route')
  })

  it('asks for a destination, and fails cleanly when a minecart is missing', async () => {
    const h = await start((bot) => {
      bot.removeItems('minecart', 1)
    })

    const noDestination = await h.call('plan_railway', {})
    await call(h, 'build_railway', { to: END, wait_seconds: 30 })
    const noCart = await call(h, 'place_minecart', { wait_seconds: 30 })

    expect(noDestination.text).toContain('no_destination')
    expect(noCart.isError).toBe(true)
    expect(noCart.text).toContain('no_minecart')
  })
})
