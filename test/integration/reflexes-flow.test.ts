import { afterEach, describe, expect, it } from '@jest/globals'
import { FakeBot } from '../fakes/fake-bot.js'
import { createHarness, type Harness } from './support/app-harness.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close().catch(() => undefined)
  harness = undefined
})

/** The fake bot stands at (10, 64, -5), on a flat stone floor at y=63 with free air above. */
const HERE = { x: 10, y: 64, z: -5 }

function flatFloor(bot: FakeBot, radius = 12): void {
  for (let x = HERE.x - radius; x <= HERE.x + radius; x += 1) {
    for (let z = HERE.z - radius; z <= HERE.z + radius; z += 1) {
      bot.setBlock({ x, y: 63, z }, 'stone')
      bot.setBlock({ x, y: 64, z }, 'air')
      bot.setBlock({ x, y: 65, z }, 'air')
    }
  }
}

async function start(
  options: {
    config?: Parameters<typeof createHarness>[0]
    withClient?: boolean
    bot?: FakeBot
  } = {},
): Promise<Harness> {
  const bot = options.bot ?? new FakeBot()
  flatFloor(bot)
  harness = await createHarness(options.config ?? {}, { bot })
  const connected = await harness.app.session.connect() // straight through the app: no MCP client involved
  if (!connected.ok) throw new Error(connected.error)
  harness.app.inbox.drain() // forget the "joined" event
  return harness
}

/** Lets the reflex engine tick `count` times (250 ms each) and the promises behind it settle. */
async function ticks(h: Harness, count = 1): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    h.scheduler.advance(250)
    await h.settle()
  }
}

const reflexEvents = (h: Harness): string[] =>
  h.app.inbox
    .drain()
    .events.filter((e) => e.type === 'reflex')
    .map((e) => e.message)

const zombieAt = (id: number, x: number) => ({
  id,
  type: 'hostile',
  name: 'zombie',
  position: { x, y: 64, z: HERE.z },
})

describe('survival reflexes, with no MCP client attached', () => {
  it('eats when hungry, with the best food, and tells the agent', async () => {
    const bot = new FakeBot()
    bot.food = 8
    bot.foodPerConsume = 10
    bot.inventoryItems = [
      { name: 'apple', count: 3 },
      { name: 'cooked_beef', count: 5 },
      { name: 'rotten_flesh', count: 9 },
    ]
    const h = await start({ bot })

    await ticks(h, 2)

    expect(bot.equipped).toEqual([{ itemType: 100, slot: 'hand' }]) // cooked_beef, once
    expect(bot.consumeCalls).toBe(1)
    expect(reflexEvents(h)).toEqual(['Ate cooked_beef (food 8 → 18).'])
  })

  it('warns once when hungry with nothing safe to eat', async () => {
    const bot = new FakeBot()
    bot.food = 5
    bot.inventoryItems = [{ name: 'rotten_flesh', count: 5 }]
    const h = await start({ bot })

    await ticks(h, 6)

    expect(reflexEvents(h)).toEqual(['Hungry (food 5/20) but there is nothing safe to eat.'])
    expect(bot.consumeCalls).toBe(0)
  })

  it('fights a zombie that comes close, and says how it went', async () => {
    const bot = new FakeBot()
    bot.inventoryItems = [{ name: 'iron_sword', count: 1 }]
    bot.onAttack = (entity) => {
      bot.removeEntity(entity.id) // one hit kills it
    }
    const h = await start({ bot })
    bot.entities['30'] = zombieAt(30, HERE.x + 2)

    await ticks(h, 3)

    expect(bot.attacked).toEqual([30])
    expect(bot.equipped).toContainEqual({ itemType: 111, slot: 'hand' }) // iron sword in hand first
    expect(reflexEvents(h)).toEqual(['Fighting a zombie (health 20/20).', 'The zombie is gone.'])
    expect(h.app.reflexes.activeReflex()).toBeUndefined()
  })

  it('ignores an enderman, even a close one', async () => {
    const bot = new FakeBot()
    const h = await start({ bot })
    bot.entities['31'] = {
      id: 31,
      type: 'hostile',
      name: 'enderman',
      position: { x: HERE.x + 2, y: 64, z: HERE.z },
    }

    await ticks(h, 4)

    expect(bot.attacked).toEqual([])
    expect(reflexEvents(h)).toEqual([])
    expect(h.app.reflexes.activeReflex()).toBeUndefined()
  })

  it('moves away from lava next to it, and stops when the lava is gone', async () => {
    const bot = new FakeBot()
    const h = await start({ bot })
    bot.setBlock({ x: HERE.x + 1, y: 64, z: HERE.z }, 'lava')

    await ticks(h, 2)

    expect(h.app.reflexes.activeReflex()).toBe('avoid_lava')
    expect(bot.pathfinder.gotoGoals).toHaveLength(1)
    const goal = bot.pathfinder.gotoGoals[0] as { x: number; z: number }
    // the lava block is at (11, -5): compare block centers, and the spot must not touch it
    expect(Math.hypot(goal.x - (HERE.x + 1.5), goal.z - (HERE.z + 0.5))).toBeGreaterThanOrEqual(2)
    expect(reflexEvents(h)).toEqual(['Lava next to me: moving away.'])

    bot.setBlock({ x: HERE.x + 1, y: 64, z: HERE.z }, 'air')
    await ticks(h, 2)
    expect(h.app.reflexes.activeReflex()).toBeUndefined()
  })

  it('a bot standing in lava also holds jump to swim up, and lets go afterwards', async () => {
    const bot = new FakeBot()
    const h = await start({ bot })
    bot.setBlock({ x: HERE.x, y: 64, z: HERE.z }, 'lava') // the feet block

    await ticks(h, 2)
    bot.setBlock({ x: HERE.x, y: 64, z: HERE.z }, 'air')
    await ticks(h, 2)

    expect(bot.controlStates).toContainEqual({ control: 'jump', active: true })
    expect(bot.controlStates.at(-1)).toEqual({ control: 'jump', active: false })
  })

  it('swims up for air when running out', async () => {
    const bot = new FakeBot()
    const h = await start({ bot })
    bot.setBlock({ x: HERE.x, y: 64, z: HERE.z }, 'water')
    bot.setBlock({ x: HERE.x, y: 65, z: HERE.z }, 'water')
    bot.oxygenLevel = 4

    await ticks(h, 2)

    expect(h.app.reflexes.activeReflex()).toBe('drowning')
    expect(bot.controlStates).toContainEqual({ control: 'jump', active: true })
    expect(reflexEvents(h)[0]).toContain('Running out of air')
  })

  it('lava comes before a zombie: the most important reflex acts first', async () => {
    const bot = new FakeBot()
    const h = await start({ bot })
    bot.entities['30'] = zombieAt(30, HERE.x + 2)
    bot.setBlock({ x: HERE.x - 1, y: 64, z: HERE.z }, 'lava')

    await ticks(h, 2)

    expect(h.app.reflexes.activeReflex()).toBe('avoid_lava')
    expect(bot.attacked).toEqual([])
  })

  it('does nothing when the reflexes are switched off', async () => {
    const bot = new FakeBot()
    bot.food = 5
    bot.inventoryItems = [{ name: 'bread', count: 2 }]
    const h = await start({ bot, config: { reflexesEnabled: false } })
    bot.entities['30'] = zombieAt(30, HERE.x + 2)

    await ticks(h, 4)

    expect(bot.consumeCalls).toBe(0)
    expect(bot.attacked).toEqual([])
    expect(h.app.reflexes.isStarted).toBe(false)
  })

  it('stops reacting once the bot has left the world', async () => {
    const bot = new FakeBot()
    const h = await start({ bot })
    expect(h.app.reflexes.isStarted).toBe(true)

    bot.emit('end', 'socketClosed')
    await h.settle()

    expect(h.app.reflexes.isStarted).toBe(false)
    bot.entities['30'] = zombieAt(30, HERE.x + 2)
    await ticks(h, 3)
    expect(bot.attacked).toEqual([])
  })
})

describe('reflexes and the running task', () => {
  async function withGoto(bot: FakeBot): Promise<Harness> {
    const h = await start({ bot })
    const started = await h.call('goto', { x: 40, y: 64, z: -5, wait_seconds: 0 })
    expect(started.isError).toBe(false)
    h.app.inbox.drain()
    return h
  }

  it('a fight pauses the trip and, when it is over, the trip carries on', async () => {
    const bot = new FakeBot()
    bot.onAttack = (entity) => {
      bot.removeEntity(entity.id)
    }
    const h = await withGoto(bot)
    expect(bot.pathfinder.gotoGoals).toHaveLength(1)
    bot.entities['30'] = zombieAt(30, HERE.x + 2)

    await ticks(h, 4)

    expect(bot.attacked).toEqual([30])
    expect(bot.pathfinder.gotoGoals).toHaveLength(2) // the same trip, started again
    expect(bot.pathfinder.gotoGoals[1]).toEqual(bot.pathfinder.gotoGoals[0])
    expect(reflexEvents(h)).toEqual([
      'Paused "Go to 40, 64, -5" for a survival reaction (threat_response).',
      'Fighting a zombie (health 20/20).',
      'The zombie is gone.',
      'Resumed "Go to 40, 64, -5".',
    ])
    expect(h.app.tasks.current()?.description).toBe('Go to 40, 64, -5')
  })

  it('running away does not resume the trip (it would lead back to the danger), and the agent is told', async () => {
    const bot = new FakeBot()
    const h = await withGoto(bot)
    bot.entities['40'] = {
      id: 40,
      type: 'hostile',
      name: 'creeper',
      position: { x: HERE.x + 5, y: 64, z: HERE.z },
    }
    await ticks(h, 2)
    expect(h.app.reflexes.activeReflex()).toBe('threat_response')

    bot.removeEntity(40)
    await ticks(h, 4)

    const events = reflexEvents(h)
    expect(events[0]).toContain('Paused "Go to 40, 64, -5"')
    expect(events).toContain('Running away from creeper.')
    expect(events).toContain('Safe again: no threat nearby.')
    expect(events.at(-1)).toContain('was not resumed')
    expect(h.app.tasks.current()).toBeUndefined()
    expect(bot.pathfinder.gotoGoals.length).toBeGreaterThanOrEqual(2) // the flee trip, not a resumed goto to x=40
    expect(bot.pathfinder.gotoGoals.every((g) => (g as { x: number }).x !== 40)).toBe(false) // the original trip is the only one to x=40
  })

  it('the owner saying "stop" during a fight means nothing is resumed afterwards', async () => {
    const bot = new FakeBot()
    bot.onAttack = () => undefined // the zombie survives for now
    const h = await withGoto(bot)
    const zombie = zombieAt(30, HERE.x + 2)
    bot.entities['30'] = zombie
    await ticks(h, 2)

    bot.emit('chat', 'Andrey_Knight', 'stop')
    bot.removeEntity(30)
    await ticks(h, 4)

    expect(bot.pathfinder.gotoGoals).toHaveLength(1) // never restarted
    expect(h.app.tasks.current()).toBeUndefined()
    expect(reflexEvents(h).some((m) => m.startsWith('Resumed'))).toBe(false)
  })

  it('eating does not interrupt the trip', async () => {
    const bot = new FakeBot()
    bot.food = 6
    bot.foodPerConsume = 10
    bot.inventoryItems = [{ name: 'bread', count: 4 }]
    const h = await withGoto(bot)

    await ticks(h, 2)

    expect(bot.consumeCalls).toBe(1)
    expect(h.app.tasks.current()?.status).toBe('running')
    expect(bot.pathfinder.gotoGoals).toHaveLength(1)
  })

  it('a task cannot be started while a reflex is acting, and the agent is told why', async () => {
    const bot = new FakeBot()
    const h = await start({ bot })
    bot.entities['30'] = zombieAt(30, HERE.x + 2)
    bot.onAttack = () => undefined
    await ticks(h, 2)
    expect(h.app.reflexes.activeReflex()).toBe('threat_response')

    const refused = await h.call('goto', { x: 1, y: 64, z: 1, wait_seconds: 0 })

    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('threat_response')
  })
})

describe('reflexes as seen by the agent', () => {
  it('the events arrive in the next wait_for_chat', async () => {
    const bot = new FakeBot()
    bot.food = 8
    bot.foodPerConsume = 10
    bot.inventoryItems = [{ name: 'bread', count: 2 }]
    const h = await start({ bot })
    await ticks(h, 2)

    const heard = await h.call('wait_for_chat', { timeout_seconds: 1 })

    expect(heard.data).toMatchObject({
      events: [{ type: 'reflex', message: 'Ate bread (food 8 → 18).' }],
    })
  })

  it('get_status says whether the reflexes are on and which one is acting', async () => {
    const bot = new FakeBot()
    const h = await start({ bot })
    bot.entities['30'] = zombieAt(30, HERE.x + 2)
    bot.onAttack = () => undefined

    expect((await h.call('get_status')).data).toMatchObject({
      reflexes: { enabled: true, active: null },
    })
    await ticks(h, 2)
    expect((await h.call('get_status')).data).toMatchObject({
      reflexes: { enabled: true, active: 'threat_response' },
    })
  })

  it('the history log records the reflex events, so a later session can read them', async () => {
    const bot = new FakeBot()
    bot.food = 8
    bot.foodPerConsume = 10
    bot.inventoryItems = [{ name: 'bread', count: 2 }]
    const h = await start({ bot })
    await ticks(h, 2)

    const history = await h.call('get_recent_history', { kind: 'event' })

    expect(JSON.stringify(history.data)).toContain('reflex: Ate bread')
  })
})
