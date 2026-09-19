import { afterEach, describe, expect, it } from '@jest/globals'
import { FakeBot } from '../fakes/fake-bot.js'
import { createHarness, type Harness } from './support/app-harness.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close().catch(() => undefined)
  harness = undefined
})

/** The bot stands at (10, 64, -5) on a flat dirt floor at y=63 with free air above. */
const HERE = { x: 10, y: 64, z: -5 }

function flatFloor(bot: FakeBot, radius = 30): void {
  for (let x = HERE.x - radius; x <= HERE.x + radius; x += 1) {
    for (let z = HERE.z - radius; z <= HERE.z + radius; z += 1) {
      bot.setBlock({ x, y: 63, z }, 'dirt')
      bot.setBlock({ x, y: 62, z }, 'dirt')
      for (let y = 64; y <= 72; y += 1) bot.setBlock({ x, y, z }, 'air')
    }
  }
}

const tree = (bot: FakeBot, x: number, z: number, height: number): void => {
  for (let y = 64; y < 64 + height; y += 1) bot.setBlock({ x, y, z }, 'oak_log')
}

/** A wall of `name` blocks, one thick, standing on the floor. */
const wall = (
  bot: FakeBot,
  name: string,
  x: number,
  z: number,
  length: number,
  height = 2,
): void => {
  for (let dz = 0; dz < length; dz += 1)
    for (let y = 64; y < 64 + height; y += 1) bot.setBlock({ x, y, z: z + dz }, name)
}

async function start(setup: (bot: FakeBot) => void = () => undefined): Promise<Harness> {
  const bot = new FakeBot().useGameData()
  flatFloor(bot)
  setup(bot)
  const h = await createHarness({}, { bot })
  harness = h
  bot.now = () => h.clock.now()
  await h.call('connect', { port: 34231 })
  await h.call('wait_for_chat', { timeout_seconds: 1 }) // drain the "joined" event
  return h
}

/** Lets time pass in small steps until the call finishes, since skills wait on the fake scheduler. */
async function pumped<T>(h: Harness, promise: Promise<T>): Promise<T> {
  const state = { done: false }
  const tracked = promise.finally(() => {
    state.done = true
  })
  while (!state.done) {
    h.scheduler.advance(500)
    await h.settle()
  }
  return tracked
}

const call = (h: Harness, name: string, args: Record<string, unknown> = {}) =>
  pumped(h, h.call(name, args))

const task = (result: { data: unknown }): Record<string, unknown> =>
  result.data as Record<string, unknown>

describe('gathering, crafting, and smelting through the MCP server', () => {
  it('goes from trees to a wooden pickaxe: collect logs, craft planks, and a table is made on the way', async () => {
    const h = await start((bot) => {
      tree(bot, 14, -5, 4)
      tree(bot, 17, -5, 3)
    })

    const collected = await call(h, 'collect_block', {
      blocks: ['logs'],
      count: 5,
      wait_seconds: 30,
    })

    expect(task(collected)).toMatchObject({
      status: 'succeeded',
      result: { mined: 5, requested: 5, gained: [{ name: 'oak_log', count: 5 }] },
    })
    expect(h.bot.count('oak_log')).toBe(5)
    expect(h.bot.dug).toHaveLength(5)
    expect(h.bot.dug[0]?.position).toEqual({ x: 14, y: 64, z: -5 }) // the nearest tree, from the bottom

    const planks = await call(h, 'craft', { item: 'oak_planks', count: 8 })
    expect(task(planks)).toMatchObject({ status: 'succeeded', result: { produced: 8 } })
    expect(h.bot.count('oak_planks')).toBe(8)

    const pickaxe = await call(h, 'craft', { item: 'wooden_pickaxe' })
    expect(task(pickaxe)).toMatchObject({
      status: 'succeeded',
      result: { item: 'wooden_pickaxe', produced: 1, placedTable: true },
    })
    expect(h.bot.count('wooden_pickaxe')).toBe(1)
    expect(h.bot.placed.map((p) => p.name)).toEqual(['crafting_table'])
    expect(h.bot.count('oak_log')).toBe(2) // 5 logs: 2 for the first 8 planks, 1 for planks to finish the pickaxe
  })

  it('mines stone with the wooden pickaxe, refuses iron ore until it has a stone pickaxe, then gets iron', async () => {
    const h = await start((bot) => {
      wall(bot, 'stone', 20, -5, 6)
      wall(bot, 'iron_ore', 24, -5, 3)
      bot.inventoryItems = [
        { name: 'wooden_pickaxe', count: 1 },
        { name: 'stick', count: 4 },
      ]
    })

    const tooSoon = await call(h, 'collect_block', { blocks: ['iron_ore'], count: 2 })
    expect(tooSoon.isError).toBe(true)
    expect(tooSoon.text).toContain('stone_pickaxe')
    expect(tooSoon.text).toContain('no_suitable_tool')
    expect(h.bot.dug).toEqual([])

    const stone = await call(h, 'collect_block', { blocks: ['stone'], count: 5, wait_seconds: 30 })
    expect(task(stone)).toMatchObject({
      status: 'succeeded',
      result: { gained: [{ name: 'cobblestone', count: 5 }] },
    })
    expect(h.bot.heldItem?.name).toBe('wooden_pickaxe')

    // A stone pickaxe needs a crafting table: none stands here and there are no planks, so it says what is missing.
    const noTable = await call(h, 'craft', { item: 'stone_pickaxe' })
    expect(noTable.isError).toBe(true)
    expect(noTable.text).toContain('missing_materials')
    expect(noTable.text).toContain('crafting table')

    h.bot.addItems('oak_planks', 4)
    const made = await call(h, 'craft', { item: 'stone_pickaxe' })
    expect(task(made)).toMatchObject({
      status: 'succeeded',
      result: { produced: 1, placedTable: true },
    })

    const iron = await call(h, 'collect_block', {
      blocks: ['iron_ore'],
      count: 2,
      wait_seconds: 30,
    })
    expect(task(iron)).toMatchObject({
      status: 'succeeded',
      result: { mined: 2, gained: [{ name: 'raw_iron', count: 2 }] },
    })
    expect(h.bot.heldItem?.name).toBe('stone_pickaxe')
  })

  it('smelts raw iron: crafts and places a furnace, loads fuel, waits, and collects the ingots', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [
        { name: 'raw_iron', count: 3 },
        { name: 'cobblestone', count: 8 },
        { name: 'coal', count: 1 },
        { name: 'crafting_table', count: 1 },
      ]
    })

    const result = await call(h, 'smelt', { item: 'raw_iron', wait_seconds: 55 })

    expect(task(result)).toMatchObject({
      status: 'succeeded',
      result: { item: 'raw_iron', produced: 'iron_ingot', smelted: 3, requested: 3, fuel: 'coal' },
    })
    expect(h.bot.count('iron_ingot')).toBe(3)
    expect(h.bot.count('raw_iron')).toBe(0)
    expect(h.bot.placed.map((p) => p.name)).toEqual(['crafting_table', 'furnace'])
    expect([...h.bot.furnaces.values()].every((f) => f.closed)).toBe(true)
  })

  it('cancels a collect in the middle of digging and stops the dig', async () => {
    const h = await start((bot) => {
      tree(bot, 14, -5, 4)
      bot.holdDigs = true
    })

    const running = await call(h, 'collect_block', {
      blocks: ['oak_log'],
      count: 4,
      wait_seconds: 2,
    })
    expect(task(running)).toMatchObject({ status: 'running' })

    const stopped = await call(h, 'cancel_task')
    await h.settle()

    expect(task(stopped)).toBeDefined()
    expect(h.bot.stopDiggingCalls).toBe(1)
    const status = await h.call('get_task_status')
    expect(task(status).task).toMatchObject({ status: 'cancelled' })
    expect(h.bot.count('oak_log')).toBe(0)
  })

  it('never digs inside a protected area, and says which one', async () => {
    const h = await start((bot) => {
      tree(bot, 14, -5, 3)
    })
    await h.call('protect_area', {
      label: 'my garden',
      x1: 12,
      y1: 60,
      z1: -8,
      x2: 16,
      y2: 70,
      z2: -2,
    })

    const result = await call(h, 'collect_block', { blocks: ['oak_log'], count: 2 })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('protected_area')
    expect(result.text).toContain('my garden')
    expect(h.bot.dug).toEqual([])

    const listed = await h.call('list_protected_areas')
    expect(task(listed)).toMatchObject({ count: 1, areas: [{ label: 'my garden' }] })
  })

  it('stops with inventory_full and says how much is left to collect', async () => {
    const h = await start((bot) => {
      tree(bot, 14, -5, 5)
      bot.slotLimit = 2
      bot.inventoryItems = [{ name: 'dirt', count: 64 }]
    })

    const result = await call(h, 'collect_block', {
      blocks: ['oak_log'],
      count: 4,
      wait_seconds: 30,
      on_inventory_full: 'stop',
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('inventory_full')
    expect(result.text).toContain('Collected 1 of 4')
    expect(h.bot.count('oak_log')).toBe(1)
  })

  it('picks up dropped items, and reports when there are none', async () => {
    const h = await start()
    h.bot.dropItem('apple', 2, { x: 14.5, y: 64, z: -4.5 })

    const picked = await call(h, 'pickup_items', { items: ['apple'] })
    const none = await call(h, 'pickup_items', { items: ['apple'] })

    expect(task(picked)).toMatchObject({
      status: 'succeeded',
      result: { picked: [{ name: 'apple', count: 2 }] },
    })
    expect(h.bot.count('apple')).toBe(2)
    expect(none.isError).toBe(true)
    expect(none.text).toContain('no_items_nearby')
  })

  it('answers recipe questions from the bot inventory', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [{ name: 'birch_log', count: 1 }]
    })

    const recipes = await h.call('list_recipes', { item: 'stick' })
    const now = await h.call('list_recipes', { craftable_now: true })

    expect(task(recipes)).toMatchObject({
      item: 'stick',
      canCraftNow: true,
      steps: ['birch_planks x1', 'stick x1'],
    })
    expect((task(now).items as { item: string }[]).map((i) => i.item)).toContain('birch_planks')
  })

  it('tells an unknown item apart from one that cannot be crafted', async () => {
    const h = await start()

    const unknown = await call(h, 'craft', { item: 'wooden_pickax' })
    const raw = await call(h, 'craft', { item: 'cobblestone' })

    expect(unknown.text).toContain('unknown_item')
    expect(raw.text).toContain('no_recipe')
  })
})
