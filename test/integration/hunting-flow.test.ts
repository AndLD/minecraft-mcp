import { afterEach, describe, expect, it } from '@jest/globals'
import type { EntityLike } from '../../src/bot/bot-like.types.js'
import { ANIMAL_KEYS, FakeBot } from '../fakes/fake-bot.js'
import { createHarness, type Harness } from './support/app-harness.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close().catch(() => undefined)
  harness = undefined
})

/** The bot stands at (10, 64, -5) on a flat dirt floor. */
const HERE = { x: 10, y: 64, z: -5 }

function flatFloor(bot: FakeBot, radius = 20): void {
  for (let x = HERE.x - radius; x <= HERE.x + radius; x += 1) {
    for (let z = HERE.z - radius; z <= HERE.z + radius; z += 1) {
      bot.setBlock({ x, y: 63, z }, 'dirt')
      bot.setBlock({ x, y: 62, z }, 'dirt')
      for (let y = 64; y <= 68; y += 1) bot.setBlock({ x, y, z }, 'air')
    }
  }
}

/** Places around the bot, all within melee reach (2.8 blocks), so the fake bot needs no chase. */
const SPOTS = [
  { x: 11.5, z: -5 },
  { x: 12, z: -6 },
  { x: 12, z: -4 },
  { x: 10, z: -3 },
  { x: 10, z: -7 },
  { x: 8.5, z: -5 },
]

let nextId = 100
function creature(
  species: string,
  spot: number,
  values: Record<string, unknown> = {},
  keys: readonly string[] = ANIMAL_KEYS,
): EntityLike {
  nextId += 1
  const place = SPOTS[spot % SPOTS.length] ?? SPOTS[0] ?? { x: 11, z: -5 }
  return {
    id: nextId,
    type: 'animal',
    name: species,
    position: { x: place.x, y: 64, z: place.z },
    metadata: keys.map((key) => values[key]),
  }
}

/** One hit kills: the animal is marked dead (it lingers, like in the game) and drops two of its meat. */
function killOnHit(bot: FakeBot): void {
  bot.onAttack = (target) => {
    const dead = bot.entities[String(target.id)]
    if (dead === undefined) return
    bot.entities[String(target.id)] = { ...dead, isDead: true }
    bot.dropItem(dead.name === 'pig' ? 'porkchop' : 'beef', 2, {
      x: dead.position.x,
      y: 64.3,
      z: dead.position.z,
    })
  }
}

async function start(setup: (bot: FakeBot) => void = () => undefined): Promise<Harness> {
  const bot = new FakeBot().useGameData()
  flatFloor(bot)
  killOnHit(bot)
  setup(bot)
  const h = await createHarness({}, { bot })
  harness = h
  bot.now = () => h.clock.now()
  await h.call('connect', { port: 34231 })
  await h.call('wait_for_chat', { timeout_seconds: 1 })
  return h
}

/** Lets time pass in small steps until the call finishes, since combat and pickups wait on the fake scheduler. */
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
const data = (result: { data: unknown }): Record<string, unknown> =>
  result.data as Record<string, unknown>

describe('hunting through the MCP server', () => {
  it('hunts cooked beef: kills cows, picks up the beef, cooks it, and leaves the named cow and the herd minimum alone', async () => {
    let named = 0
    const h = await start((bot) => {
      const cows = [
        creature('cow', 0),
        creature('cow', 1),
        creature('cow', 2),
        creature('cow', 3),
        creature('cow', 4),
      ]
      const pet = creature('cow', 5, { custom_name: { text: 'Bessie' } })
      named = pet.id
      for (const entity of [...cows, pet]) bot.entities[String(entity.id)] = entity
      bot.inventoryItems = [
        { name: 'furnace', count: 1 },
        { name: 'coal', count: 2 },
      ]
    })

    const result = await call(h, 'hunt_animals', {
      item: 'cooked_beef',
      count: 4,
      wait_seconds: 55,
    })

    expect(data(result)).toMatchObject({
      status: 'succeeded',
      result: { killed: 2, cooked: [{ name: 'cooked_beef', count: 4 }] },
    })
    expect(h.bot.count('cooked_beef')).toBe(4)
    expect(h.bot.count('beef')).toBe(0)
    expect(h.bot.attacked).not.toContain(named)
    expect(h.bot.entities[String(named)]).toBeDefined()
  })

  it('stops at the last breeding pair and reports it', async () => {
    const h = await start((bot) => {
      for (const spot of [0, 1, 2]) {
        const cow = creature('cow', spot)
        bot.entities[String(cow.id)] = cow
      }
    })

    const result = await call(h, 'hunt_animals', { species: ['cow'], count: 5 })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('breeding_floor')
    expect(result.text).toContain('Killed 1')
    expect(h.bot.attacked).toHaveLength(1)
    expect(h.bot.count('beef')).toBe(2)
  })

  it('lists what is around and why some animals are protected', async () => {
    const h = await start((bot) => {
      const animals = [
        creature('cow', 0),
        creature('cow', 1),
        creature('cow', 2),
        creature('pig', 3, { saddle: true }, [...ANIMAL_KEYS, 'saddle']),
        creature('wolf', 4, { owneruuid: 'abc' }, [...ANIMAL_KEYS, 'flags', 'owneruuid']),
      ]
      for (const entity of animals) bot.entities[String(entity.id)] = entity
    })

    const result = await h.call('list_huntable_animals')

    const listed = data(result) as {
      species: { species: string; huntable: number }[]
      animals: { species: string; status: string }[]
    }
    expect(listed.species).toEqual([
      { species: 'cow', livestock: true, adults: 3, babies: 0, huntable: 3 },
      { species: 'pig', livestock: true, adults: 1, babies: 0, huntable: 0 },
      { species: 'wolf', livestock: false, adults: 1, babies: 0, huntable: 0 },
    ])
    expect(listed.animals.find((a) => a.species === 'wolf')?.status).toBe('is tamed')
    expect(listed.animals.find((a) => a.species === 'pig')?.status).toBe('is saddled')
  })

  it('refuses to attack a tamed wolf, and attacks it only when forced', async () => {
    let wolf = 0
    const h = await start((bot) => {
      const entity = creature('wolf', 0, { owneruuid: 'abc' }, [
        ...ANIMAL_KEYS,
        'flags',
        'owneruuid',
      ])
      wolf = entity.id
      bot.entities[String(wolf)] = entity
    })

    const refused = await call(h, 'attack_entity', { entity_id: wolf })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('is tamed')
    expect(h.bot.attacked).toEqual([])

    const forced = await call(h, 'attack_entity', { entity_id: wolf, force: true })
    expect(data(forced)).toMatchObject({
      status: 'succeeded',
      result: { species: 'wolf', killed: true },
    })
    expect(h.bot.attacked).toEqual([wolf])
  })
})

describe('running out of food', () => {
  const hungry = (bot: FakeBot): void => {
    bot.food = 6
    for (const spot of [0, 1, 2, 3]) {
      const cow = creature('cow', spot)
      bot.entities[String(cow.id)] = cow
    }
  }
  const events = (h: Harness) => h.app.inbox.drain().events

  async function ticks(h: Harness, count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      h.scheduler.advance(250)
      await h.settle()
    }
  }

  it('asks the agent to ask the player when no policy is set', async () => {
    const h = await start(hungry)

    await ticks(h, 4)

    const found = events(h)
    expect(
      found.some((e) => e.type === 'needs_decision' && e.message.includes('set_food_policy')),
    ).toBe(true)
    expect((await h.call('get_task_status')).isError).toBe(false)
    expect(h.bot.attacked).toEqual([])
  })

  it('hunts and cooks by itself under a "hunt_and_cook" policy, with no agent round trip', async () => {
    const h = await start(hungry)
    await h.call('set_food_policy', { policy: 'hunt_and_cook' })

    await ticks(h, 4) // the reflex notices, then the hunt starts two seconds later
    h.scheduler.advance(2000)
    await h.settle()
    await pumped(
      h,
      (async () => {
        for (let i = 0; i < 40; i += 1) await h.settle()
      })(),
    )

    const found = events(h)
    expect(found.some((e) => e.type === 'reflex' && e.message.includes('started hunting'))).toBe(
      true,
    )
    expect(h.bot.attacked.length).toBeGreaterThan(0)
    const briefing = await h.call('get_session_briefing')
    expect(briefing.text).toContain('hunts animals')
  })

  it('cancels the task under a "stop" policy', async () => {
    const h = await start(hungry)
    await h.call('set_food_policy', { policy: 'stop' })
    h.bot.pathfinder.onGoto = undefined // trips no longer finish by themselves
    const running = await h.call('goto', { x: 90, y: 64, z: -5, wait_seconds: 0 })
    expect(data(running)).toMatchObject({ status: 'running' })

    await ticks(h, 4)

    const found = events(h)
    expect(found.some((e) => e.message.includes('food policy is "stop"'))).toBe(true)
    expect(data(await h.call('get_task_status')).task).toMatchObject({ status: 'cancelled' })
  })
})
