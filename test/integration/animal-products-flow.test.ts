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
const SHEEP_KEYS = [...ANIMAL_KEYS, 'wool']

let nextId = 300
function creature(
  species: string,
  position: { x: number; y: number; z: number },
  wool = 0,
): EntityLike {
  nextId += 1
  const keys = species === 'sheep' ? SHEEP_KEYS : ANIMAL_KEYS
  return {
    id: nextId,
    type: 'animal',
    name: species,
    position,
    metadata: keys.map((key) => (key === 'wool' ? wool : undefined)),
  }
}

/** Puts an entity in the fake world's table under its own id, as the real table does. */
function place(bot: FakeBot, entity: EntityLike): void {
  bot.entities[String(entity.id)] = entity
}

async function start(setup: (bot: FakeBot) => void): Promise<Harness> {
  const bot = new FakeBot().useGameData()
  for (let x = -10; x <= 30; x += 1)
    for (let z = -25; z <= 15; z += 1) {
      bot.setBlock({ x, y: 63, z }, 'dirt')
      for (let y = 64; y <= 69; y += 1) bot.setBlock({ x, y, z }, 'air')
    }
  bot.entity = { position: at(10.5, 64, -5.5) }
  bot.physics = true
  // Shears cut the wool of the sheep they are used on; a bucket takes milk from a cow.
  bot.onActivateEntity = (entity) => {
    const held = bot.heldItem?.name
    if (held === 'shears' && entity.name === 'sheep') {
      const index = SHEEP_KEYS.indexOf('wool')
      const flags = Number(entity.metadata?.[index] ?? 0)
      bot.entities[String(entity.id)] = {
        ...entity,
        metadata: SHEEP_KEYS.map((key, i) => (i === index ? flags | 0x10 : entity.metadata?.[i])),
      }
      bot.addItems('white_wool', 2)
    }
    if (held === 'bucket' && entity.name === 'cow') {
      bot.removeItems('bucket', 1)
      bot.addItems('milk_bucket', 1)
    }
  }
  setup(bot)
  const h = await createHarness({}, { bot })
  harness = h
  bot.now = () => h.clock.now()
  await h.call('connect', { port: 34231 })
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

describe('animal products through the MCP server', () => {
  it('shears the sheep of a pen and milks its cows, and every animal is still there', async () => {
    const h = await start((bot) => {
      for (const x of [14, 15, 16]) place(bot, creature('sheep', at(x, 64, -5)))
      for (const x of [14, 15]) place(bot, creature('cow', at(x, 64, -4)))
      bot.addItems('shears', 1)
      bot.addItems('bucket', 2)
    })
    const registered = await h.call('register_farm', {
      kind: 'pen',
      species: 'sheep',
      from: at(13, 64, -7),
      to: at(18, 64, -2),
      label: 'mixed pen',
    })
    expect(registered.isError).toBe(false)

    const sheared = await call(h, 'shear_sheep', { farm: 'mixed pen', wait_seconds: 30 })
    const milked = await call(h, 'milk_cows', { farm: 'mixed pen', count: 2, wait_seconds: 30 })

    expect(task(sheared)).toMatchObject({
      status: 'succeeded',
      result: { sheared: 3, wool: { white_wool: 6 } },
    })
    expect(task(milked)).toMatchObject({
      status: 'succeeded',
      result: { buckets: 2, requested: 2, cows: 2 },
    })
    expect(h.bot.count('white_wool')).toBe(6)
    expect(h.bot.count('milk_bucket')).toBe(2)
    expect(Object.keys(h.bot.entities)).toHaveLength(5)
  })
})
