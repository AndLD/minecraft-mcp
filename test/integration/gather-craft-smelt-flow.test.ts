import { afterEach, describe, expect, it } from '@jest/globals'
import { toVec3 } from '../../src/bot/vec3.js'
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

const nameAt = (h: Harness, x: number, y: number, z: number): string | undefined =>
  h.bot.blockAt(toVec3({ x, y, z }))?.name

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

  it('does not stand looking into the furnace: the window is closed while the items cook', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [
        { name: 'raw_iron', count: 3 },
        { name: 'cobblestone', count: 8 },
        { name: 'coal', count: 1 },
        { name: 'crafting_table', count: 1 },
      ]
    })

    const started = await call(h, 'smelt', { item: 'raw_iron', wait_seconds: 1 })
    expect(task(started)).toMatchObject({ status: 'running' })
    for (let step = 0; step < 4; step += 1) {
      h.scheduler.advance(2_000)
      await h.settle()
    }

    expect([...h.bot.furnaces.values()].every((furnace) => furnace.closed)).toBe(true)
    expect(h.bot.count('raw_iron')).toBe(0)

    for (let step = 0; step < 40; step += 1) {
      h.scheduler.advance(2_000)
      await h.settle()
    }
    const finished = await call(h, 'get_task_status')
    expect(task(finished)).toMatchObject({
      task: { status: 'succeeded', result: { smelted: 3, pending: 0 } },
    })
    expect(h.bot.count('iron_ingot')).toBe(3)
  })

  it('a wait that is cancelled leaves the furnace burning, and a later smelt collects the ingots', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [
        { name: 'raw_iron', count: 3 },
        { name: 'cobblestone', count: 8 },
        { name: 'coal', count: 1 },
        { name: 'crafting_table', count: 1 },
      ]
    })
    await call(h, 'smelt', { item: 'raw_iron', wait_seconds: 1 })
    for (let step = 0; step < 3; step += 1) {
      h.scheduler.advance(2_000)
      await h.settle()
    }

    const cancelled = await call(h, 'cancel_task')
    expect(cancelled.isError).toBe(false)
    expect(h.bot.count('raw_iron')).toBe(0) // still in the furnace, not taken back
    h.scheduler.advance(40_000)
    await h.settle()

    const collected = await call(h, 'smelt', { collect: true, wait_seconds: 30 })

    expect(task(collected)).toMatchObject({
      status: 'succeeded',
      result: { item: 'raw_iron', smelted: 3, pending: 0 },
    })
    expect(h.bot.count('iron_ingot')).toBe(3)
    expect([...h.bot.furnaces.values()].every((furnace) => furnace.closed)).toBe(true)
  })

  it('a job left with start_only announces itself with smelt_ready, and collect takes the ingots', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [
        { name: 'raw_iron', count: 3 },
        { name: 'cobblestone', count: 8 },
        { name: 'coal', count: 1 },
        { name: 'crafting_table', count: 1 },
      ]
    })

    const started = await call(h, 'smelt', {
      item: 'raw_iron',
      wait: 'start_only',
      wait_seconds: 30,
    })

    expect(task(started)).toMatchObject({
      status: 'succeeded',
      result: { smelted: 0, pending: 3 },
    })
    const early = await call(h, 'wait_for_chat', { timeout_seconds: 1 })
    expect((early.data as { events: { type: string }[] }).events).toEqual([])

    // The bot is free meanwhile; when the estimate is up the agent is told.
    h.scheduler.advance(31_000)
    await h.settle()
    const heard = await call(h, 'wait_for_chat', { timeout_seconds: 1 })
    const events = (heard.data as { events: { type: string; message: string }[] }).events
    expect(events.map((event) => event.type)).toContain('smelt_ready')
    expect(events.find((event) => event.type === 'smelt_ready')?.message).toContain('collect: true')

    const collected = await call(h, 'smelt', { collect: true, wait_seconds: 30 })

    expect(task(collected)).toMatchObject({
      status: 'succeeded',
      result: { item: 'raw_iron', smelted: 3, pending: 0 },
    })
    expect(h.bot.count('iron_ingot')).toBe(3)
    const again = await call(h, 'wait_for_chat', { timeout_seconds: 1 })
    expect((again.data as { events: { type: string }[] }).events).toEqual([]) // told once
  })

  it('uses a blast furnace beside the bot for iron: done in half the time, and announced at the shorter estimate', async () => {
    const h = await start((bot) => {
      bot.setBlock({ x: 13, y: 64, z: -5 }, 'blast_furnace')
      bot.inventoryItems = [
        { name: 'raw_iron', count: 6 },
        { name: 'coal', count: 1 },
      ]
    })

    const started = await call(h, 'smelt', {
      item: 'raw_iron',
      wait: 'start_only',
      wait_seconds: 30,
    })

    expect(task(started)).toMatchObject({
      status: 'succeeded',
      result: { station: 'blast_furnace', pending: 6 },
    })
    // Six iron take a minute in a furnace and half of that here: the agent hears at 30 seconds.
    h.scheduler.advance(31_000)
    await h.settle()
    const heard = await call(h, 'wait_for_chat', { timeout_seconds: 1 })
    const events = (heard.data as { events: { type: string }[] }).events
    expect(events.map((event) => event.type)).toContain('smelt_ready')

    const collected = await call(h, 'smelt', { collect: true, wait_seconds: 30 })

    expect(task(collected)).toMatchObject({
      status: 'succeeded',
      result: { smelted: 6, pending: 0, station: 'blast_furnace' },
    })
    expect(h.bot.count('iron_ingot')).toBe(6)
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
      result: {
        item: 'raw_iron',
        produced: 'iron_ingot',
        smelted: 3,
        requested: 3,
        fuel: 'coal',
        pending: 0,
      },
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

  it('digs a small quarry for a big bulk-terrain request instead of scattered holes', async () => {
    // One more solid layer below the floor, so drops from the second dug layer land on something and are not
    // lost falling into the (otherwise unset, non-solid) void beneath the fixture's shallow floor.
    const h = await start((bot) => {
      for (let x = 8; x <= 18; x += 1)
        for (let z = -8; z <= 2; z += 1) bot.setBlock({ x, y: 61, z }, 'bedrock')
    })

    const collected = await call(h, 'collect_block', {
      blocks: ['dirt'],
      count: 32,
      wait_seconds: 45,
    })

    const result = task(collected).result as { layout: string; mined: number; shape?: string }
    expect(task(collected).status).toBe('succeeded')
    expect(result.layout).toBe('structured')
    expect(result.shape).toContain('quarry')
    expect(result.mined).toBeGreaterThanOrEqual(32)
    // The footprint (2 blocks east of the bot at x=10,z=-5, per the shared default origin) is a contained block,
    // not scattered single-block holes: both layers of a corner cell are open.
    expect(nameAt(h, 12, 63, -5)).toBe('air')
    expect(nameAt(h, 12, 62, -5)).toBe('air')
    expect(h.bot.count('dirt')).toBeGreaterThanOrEqual(32)
  })

  it('still digs scattered for a small bulk-terrain request, unchanged', async () => {
    const h = await start()

    const collected = await call(h, 'collect_block', {
      blocks: ['dirt'],
      count: 3,
      wait_seconds: 30,
    })

    const result = task(collected).result as { layout: string; mined: number }
    expect(task(collected).status).toBe('succeeded')
    expect(result.layout).toBe('scattered')
    expect(result.mined).toBe(3)
  })

  it('falls back to scattered when the structured site is not suitable, and says why', async () => {
    const h = await start()
    // The default structured-dig origin (12, 63, -5) sits inside this protected area.
    await h.call('protect_area', { label: 'base', x1: 10, y1: 60, z1: -10, x2: 20, y2: 70, z2: 0 })

    const collected = await call(h, 'collect_block', {
      blocks: ['dirt'],
      count: 32,
      wait_seconds: 45,
    })

    const result = task(collected).result as {
      layout: string
      mined: number
      structuredFallbackReason?: string
    }
    expect(task(collected).status).toBe('succeeded')
    expect(result.layout).toBe('scattered')
    expect(result.mined).toBe(32)
    expect(result.structuredFallbackReason).toMatch(/protected/)
  })
})
