import { afterEach, describe, expect, it } from '@jest/globals'
import type { EntityLike } from '../../src/bot/bot-like.types.js'
import { ANIMAL_KEYS, FakeBot } from '../fakes/fake-bot.js'
import { createHarness, type Harness } from './support/app-harness.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close().catch(() => undefined)
  harness = undefined
})

const at = (x: number, y: number, z: number) => ({ x, y, z })

function flatFloor(bot: FakeBot, center = at(10, 64, -5), radius = 20): void {
  for (let x = center.x - radius; x <= center.x + radius; x += 1) {
    for (let z = center.z - radius; z <= center.z + radius; z += 1) {
      bot.setBlock({ x, y: center.y - 1, z }, 'dirt')
      for (let y = center.y; y <= center.y + 5; y += 1) bot.setBlock({ x, y, z }, 'air')
    }
  }
}

let nextId = 200
function creature(
  species: string,
  position: { x: number; y: number; z: number },
  values: Record<string, unknown> = {},
  keys: readonly string[] = ANIMAL_KEYS,
): EntityLike {
  nextId += 1
  return { id: nextId, type: 'animal', name: species, position, metadata: keys.map((key) => values[key]) }
}

/** Places an entity in the fake world's entity table, keyed by its own id (as the real bot.entities is). */
function place(bot: FakeBot, entity: EntityLike): void {
  bot.entities[String(entity.id)] = entity
}

async function start(setup: (bot: FakeBot) => void = () => undefined): Promise<Harness> {
  const bot = new FakeBot().useGameData()
  flatFloor(bot)
  bot.entity = { position: at(10.5, 64, -5.5) }
  bot.physics = true
  bot.addItems('oak_fence', 40)
  bot.addItems('oak_fence_gate', 2)
  bot.addItems('wheat', 10)
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

describe('animal farming through the MCP server', () => {
  it('builds a fenced pen and registers it under kind "pen" with its species', async () => {
    const h = await start()

    const result = await call(h, 'build_farm', {
      kind: 'pen',
      params: { width: 4, length: 4, species: 'cow', water: false, torches: false },
      origin: at(2, 63, 0),
      label: 'cow pen',
      herd_target: 6,
      wait_seconds: 30,
    })

    expect(task(result)).toMatchObject({ status: 'succeeded' })
    const list = await h.call('list_farms')
    expect(task(list)).toMatchObject({
      farms: [{ kind: 'pen', species: 'cow', herdTarget: 6, label: 'cow pen' }],
    })
  })

  it('leads a nearby wild cow toward a registered pen', async () => {
    const h = await start((bot) => {
      place(bot, creature('cow', at(15, 64, -5)))
    })
    const registered = await h.call('register_farm', {
      kind: 'pen',
      species: 'cow',
      from: at(14, 64, -6),
      to: at(17, 64, -3),
      label: 'cow pen',
    })
    expect(registered.isError).toBe(false)

    const result = await call(h, 'lure_animals', {
      species: 'cow',
      count: 1,
      farm: 'cow pen',
      wait_seconds: 30,
    })

    expect(task(result)).toMatchObject({ status: 'succeeded', result: { led: 1, abandoned: [] } })
  })

  it('feeds a pair of eligible adults, never a tamed or named one', async () => {
    const cowA = creature('cow', at(11, 64, -5))
    const cowB = creature('cow', at(12, 64, -5))
    const h = await start((bot) => {
      place(bot, cowA)
      place(bot, cowB)
      place(bot, creature('cow', at(13, 64, -5), { custom_name: 'Bessie' })) // named: excluded
    })

    const result = await call(h, 'breed_animals', {
      species: 'cow',
      target_count: 6,
      area: { from: at(9, 64, -7), to: at(15, 64, -3) },
      wait_seconds: 30,
    })

    const outcome = task(result)
    expect(outcome).toMatchObject({ status: 'succeeded' })
    expect((outcome.result as { pairsFed: number }).pairsFed).toBe(1)
    expect(h.bot.activatedEntities.sort((a, b) => a - b)).toEqual([cowA.id, cowB.id].sort((a, b) => a - b))
  })

  it('tend_farm keeps a pen at its herd target through HerdManager, inspect_farm reports the herd', async () => {
    const h = await start((bot) => {
      place(bot, creature('cow', at(11, 64, -5)))
      place(bot, creature('cow', at(12, 64, -5)))
    })
    const registered = await h.call('register_farm', {
      kind: 'pen',
      species: 'cow',
      herd_target: 4,
      from: at(9, 64, -7),
      to: at(15, 64, -3),
      label: 'cow pen',
    })
    expect(registered.isError).toBe(false)

    const before = await h.call('inspect_farm', { farm: 'cow pen' })
    expect(task(before)).toMatchObject({ components: [{ species: 'cow', adults: 2, babies: 0 }] })

    const tended = await call(h, 'tend_farm', { farm: 'cow pen', wait_seconds: 30 })

    expect(task(tended)).toMatchObject({
      status: 'succeeded',
      result: { components: [{ kind: 'pen', herdSizeBefore: 2, herdAction: 'bred' }] },
    })
  })
})
