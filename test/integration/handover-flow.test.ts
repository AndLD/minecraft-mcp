import { afterEach, describe, expect, it } from '@jest/globals'
import { FakeBot } from '../fakes/fake-bot.js'
import { createHarness, type Harness } from './support/app-harness.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close().catch(() => undefined)
  harness = undefined
})

/** The bot stands at (10, 64, -5), the owner 20 blocks east of it, both on a flat dirt floor. */
const HERE = { x: 10, y: 64, z: -5 }
const PLAYER = { x: 30, y: 64, z: -5 }
const at = (x: number, z = -5) => ({ x, y: 64, z })

async function start(setup: (bot: FakeBot) => void = () => undefined): Promise<Harness> {
  const bot = new FakeBot().useGameData()
  for (let x = HERE.x - 25; x <= HERE.x + 45; x += 1) {
    for (let z = HERE.z - 25; z <= HERE.z + 25; z += 1) {
      bot.setBlock({ x, y: 63, z }, 'dirt')
      bot.setBlock({ x, y: 62, z }, 'dirt')
      for (let y = 64; y <= 68; y += 1) bot.setBlock({ x, y, z }, 'air')
    }
  }
  bot.players['Andrey_Knight'] = {
    username: 'Andrey_Knight',
    entity: { id: 900, type: 'player', name: 'Andrey_Knight', position: PLAYER },
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
const thrown = (bot: FakeBot, name: string): number =>
  bot.tossed.filter((t) => t.name === name).reduce((sum, t) => sum + t.count, 0)

describe('handing items over through the MCP server', () => {
  it('"give me 3 stacks of cobble": takes what it carries, fetches the rest from a chest, and drops it at the player', async () => {
    const h = await start((bot) => {
      bot.setBlock(at(16), 'chest')
      bot.stock(at(16), 'cobblestone', 150)
      bot.inventoryItems = [
        { name: 'cobblestone', count: 60 },
        { name: 'iron_pickaxe', count: 1 },
      ]
    })
    await h.call('register_container', { x: 16, y: 64, z: -5, label: 'stone' })
    await call(h, 'scan_containers', { wait_seconds: 30 })

    const result = await call(h, 'give_items', {
      items: [{ item: 'cobble', stacks: 3 }],
      wait_seconds: 55,
    })

    expect(task(result)).toMatchObject({
      status: 'succeeded',
      result: {
        given: [{ name: 'cobblestone', count: 192 }],
        shortfall: [],
        mode: 'drop',
        deliveredTo: 'Andrey_Knight',
      },
    })
    expect(thrown(h.bot, 'cobblestone')).toBe(192)
    expect(h.bot.count('cobblestone')).toBe(0) // 60 carried + 132 fetched
    expect(h.bot.inContainer(at(16), 'cobblestone')).toBe(18)
    expect(h.bot.count('iron_pickaxe')).toBe(1)
    expect(h.bot.lookedAt.at(-1)?.x).toBeGreaterThan(HERE.x) // it faced the player, who stands east of it
    // Nobody picked the items up in this fake, and the result says so.
    expect((task(result).result as { unclaimed: { count: number }[] }).unclaimed[0]?.count).toBe(
      192,
    )
  })

  it('says exactly what is missing', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [{ name: 'iron_ingot', count: 6 }]
    })

    const result = await call(h, 'give_items', {
      items: [
        { item: 'iron_ingot', count: 20 },
        { item: 'diamond', count: 2 },
      ],
      wait_seconds: 55,
    })

    expect(task(result)).toMatchObject({
      status: 'succeeded',
      result: {
        given: [{ name: 'iron_ingot', count: 6 }],
        shortfall: [
          { name: 'iron_ingot', count: 14 },
          { name: 'diamond', count: 2 },
        ],
      },
    })
  })

  it('fails with the shortfall when it has none of it, without leaving its spot', async () => {
    const h = await start()

    const result = await call(h, 'give_items', { items: [{ item: 'iron_ingot', count: 20 }] })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('shortfall')
    expect(result.text).toContain('gather, craft, or hunt')
    expect(h.bot.entity?.position).toEqual(HERE)
  })

  it('asks which one for "iron", and shows what the words mean', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [
        { name: 'iron_ingot', count: 6 },
        { name: 'raw_iron', count: 9 },
      ]
    })

    const resolved = await h.call('resolve_item', { item: 'iron' })
    const asked = await call(h, 'give_items', { items: [{ item: 'iron', count: 5 }] })

    expect(resolved.data).toMatchObject({
      kind: 'ambiguous',
      candidates: [
        { item: 'raw_iron', carried: 9 },
        { item: 'iron_ingot', carried: 6 },
      ],
    })
    expect(asked.isError).toBe(true)
    expect(asked.text).toContain('ambiguous')
    expect(h.bot.tossed).toEqual([])
  })

  it('does not give the bot\'s own food when asked for "food", but gives it when named', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [{ name: 'cooked_beef', count: 8 }]
    })

    const byGroup = await call(h, 'give_items', { items: [{ item: 'food', count: 4 }] })
    const named = await call(h, 'give_items', {
      items: [{ item: 'steak', count: 4 }],
      wait_seconds: 55,
    })

    expect(byGroup.isError).toBe(true)
    expect(task(named)).toMatchObject({
      status: 'succeeded',
      result: { given: [{ name: 'cooked_beef', count: 4 }] },
    })
  })

  it('puts big amounts in a chest, and says which', async () => {
    const h = await start((bot) => {
      bot.setBlock(at(16), 'chest')
      bot.inventoryItems = [{ name: 'cobblestone', count: 500 }]
    })
    await h.call('register_container', { x: 16, y: 64, z: -5, label: 'for-andrey' })

    const result = await call(h, 'give_items', {
      items: [{ item: 'cobblestone', count: 400 }],
      mode: 'chest',
      chest: 'for-andrey',
      wait_seconds: 55,
    })

    expect(task(result)).toMatchObject({
      status: 'succeeded',
      result: { mode: 'chest', given: [{ name: 'cobblestone', count: 400 }] },
    })
    expect((task(result).result as { deliveredTo: string }).deliveredTo).toContain(
      '"for-andrey" at 16, 64, -5',
    )
    expect(h.bot.inContainer(at(16), 'cobblestone')).toBe(400)
    expect(h.bot.tossed).toEqual([])
  })

  it('reports a player who is not around', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [{ name: 'dirt', count: 5 }]
    })

    const result = await call(h, 'give_items', { items: [{ item: 'dirt' }], player: 'Ghost' })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('player_not_online')
  })

  it('drops junk where it stands, and keeps the reserve', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [
        { name: 'dirt', count: 40 },
        { name: 'cooked_beef', count: 3 },
      ]
    })

    const result = await call(h, 'drop_items', { items: [{ item: 'dirt', all: true }] })
    const food = await call(h, 'drop_items', { items: [{ item: 'food', all: true }] })

    expect(task(result)).toMatchObject({
      status: 'succeeded',
      result: { dropped: [{ name: 'dirt', count: 40 }] },
    })
    expect(h.bot.count('dirt')).toBe(0)
    expect(food.isError).toBe(true)
    expect(h.bot.count('cooked_beef')).toBe(3)
  })

  it('"take this pickaxe": walks to the player, takes what they throw after the wait began, and leaves the old drop', async () => {
    const h = await start((bot) => {
      bot.dropItem('stone_pickaxe', 1, { x: 33, y: 64, z: -5 }) // lay there before
    })
    const state = { done: false, elapsed: 0, thrown: false }
    const running = h
      .call('receive_item', {
        item: 'pickaxe',
        from_player: 'Andrey_Knight',
        use_it: true,
        wait_seconds: 55,
      })
      .finally(() => {
        state.done = true
      })
    while (!state.done && state.elapsed < 120_000) {
      h.scheduler.advance(250)
      state.elapsed += 250
      if (state.elapsed >= 3_000 && !state.thrown) {
        state.thrown = true
        h.bot.dropItem('diamond_pickaxe', 1, { x: 29, y: 64, z: -4 })
      }
      await h.settle()
    }
    const result = await running

    expect(task(result)).toMatchObject({
      status: 'succeeded',
      result: { received: [{ name: 'diamond_pickaxe', count: 1 }] },
    })
    expect(h.bot.count('diamond_pickaxe')).toBe(1)
    expect(h.bot.count('stone_pickaxe')).toBe(0)
    expect(h.bot.lookedAt.at(-1)?.x).toBeGreaterThan(HERE.x)
    const heard = await call(h, 'wait_for_chat', { timeout_seconds: 1 })
    expect(JSON.stringify(heard.data)).not.toContain('Nothing came')
  }, 30_000)

  it('ends nothing_received when nothing is thrown', async () => {
    const h = await start()

    const result = await call(h, 'receive_item', {
      from_player: 'Andrey_Knight',
      timeout_seconds: 5,
      wait_seconds: 55,
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('nothing_received')
  })
})
