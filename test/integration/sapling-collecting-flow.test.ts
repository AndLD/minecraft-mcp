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
  for (let x = -10; x <= 30; x += 1) {
    for (let z = -25; z <= 15; z += 1) {
      bot.setBlock(at(x, GROUND, z), 'dirt')
      for (let y = GROUND + 1; y <= GROUND + 12; y += 1) bot.setBlock(at(x, y, z), 'air')
    }
  }
}

/** A few oak leaves and a short trunk standing east of the bot. */
function tree(bot: FakeBot, leaves = 12): void {
  for (let y = GROUND + 1; y <= GROUND + 3; y += 1) bot.setBlock(at(14, y, -5), 'oak_log')
  for (let i = 0; i < leaves; i += 1) bot.setBlock(at(12 + (i % 4), GROUND + 4 + Math.floor(i / 4), -6 + (i % 3)), 'oak_leaves')
}

async function start(setup: (bot: FakeBot) => void = () => undefined): Promise<Harness> {
  const bot = new FakeBot().useGameData()
  flatFloor(bot)
  bot.entity = { position: at(10.5, 64, -5.5) }
  bot.physics = true
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
const task = (result: { data: unknown }): Record<string, unknown> => result.data as Record<string, unknown>

describe('sapling collecting through the MCP server', () => {
  it('breaks leaves until saplings drop, then plant_trees uses them', async () => {
    const h = await start((bot) => {
      tree(bot)
      bot.drops['oak_leaves'] = 'oak_sapling'
    })

    const collected = await call(h, 'collect_saplings', { species: 'oak', count: 2, wait_seconds: 30 })

    expect(task(collected)).toMatchObject({ status: 'succeeded', result: { requested: 2 } })
    const saplings = (task(collected).result as { saplings: number }).saplings
    expect(saplings).toBeGreaterThanOrEqual(2)
    expect(h.bot.dug.filter((d) => d.name === 'oak_leaves').length).toBeGreaterThan(0)

    const planted = await call(h, 'plant_trees', {
      species: 'oak',
      count: 2,
      area: { from: at(18, GROUND, -12), to: at(28, GROUND, -2) },
      wait_seconds: 30,
    })
    expect(task(planted)).toMatchObject({ status: 'succeeded', result: { planted: 2 } })
  })

  it('reports no_leaves when there are none, and leaf_budget when none drop a sapling', async () => {
    const none = await start()
    const missing = await call(none, 'collect_saplings', { species: 'oak', count: 1, wait_seconds: 30 })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('no_leaves')
    await none.close().catch(() => undefined)

    const dry = await start((bot) => {
      tree(bot, 12)
    })
    const budget = await call(dry, 'collect_saplings', { species: 'oak', count: 1, max_leaves: 6, wait_seconds: 30 })
    expect(budget.isError).toBe(true)
    expect(budget.text).toContain('leaf_budget')
  })

  it('collect_block brings saplings along with the logs when asked', async () => {
    const h = await start((bot) => {
      tree(bot)
      bot.drops['oak_leaves'] = 'oak_sapling'
    })

    const result = await call(h, 'collect_block', {
      blocks: ['oak_log'],
      count: 3,
      saplings: 2,
      wait_seconds: 30,
    })

    expect(task(result)).toMatchObject({
      status: 'succeeded',
      result: { mined: 3, saplings: { requested: 2, stoppedBecause: 'enough' } },
    })
    const section = (task(result).result as { saplings: { gained: number } }).saplings
    expect(section.gained).toBeGreaterThanOrEqual(2)
  })

  it('collect_block asks for no saplings unless told to', async () => {
    const h = await start((bot) => {
      tree(bot)
      bot.drops['oak_leaves'] = 'oak_sapling'
    })

    const result = await call(h, 'collect_block', { blocks: ['oak_log'], count: 3, wait_seconds: 30 })

    expect(task(result).result).not.toHaveProperty('saplings')
    expect(h.bot.dug.some((d) => d.name === 'oak_leaves')).toBe(false)
  })
})
