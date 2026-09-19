import { afterEach, describe, expect, it } from '@jest/globals'
import { FakeBot } from '../fakes/fake-bot.js'
import { createHarness, type Harness } from './support/app-harness.js'

let harnesses: Harness[] = []

afterEach(async () => {
  await Promise.all(harnesses.map((h) => h.close().catch(() => undefined)))
  harnesses = []
})

/** Flat dirt floor around the spawn point; the owner stands 20 blocks east of it. */
const SPAWN = { x: 10, y: 64, z: -5 }
const PLAYER = { x: 30, y: 64, z: -5 }
const DEATH = { x: 40, y: 64, z: -5 }
const at = (x: number, z = -5) => ({ x, y: 64, z })

function buildBot(setup: (bot: FakeBot) => void = () => undefined): FakeBot {
  const bot = new FakeBot().useGameData()
  for (let x = SPAWN.x - 25; x <= SPAWN.x + 60; x += 1) {
    for (let z = SPAWN.z - 30; z <= SPAWN.z + 30; z += 1) {
      bot.setBlock({ x, y: 63, z }, 'dirt')
      for (let dy = 1; dy <= 24; dy += 1) bot.setBlock({ x, y: 63 - dy, z }, 'dirt')
      for (let y = 64; y <= 68; y += 1) bot.setBlock({ x, y, z }, 'air')
    }
  }
  bot.players['Andrey_Knight'] = {
    username: 'Andrey_Knight',
    entity: { id: 900, type: 'player', name: 'Andrey_Knight', position: PLAYER },
  }
  setup(bot)
  return bot
}

async function start(
  options: { dataDir?: string; setup?: (bot: FakeBot) => void; bot?: FakeBot } = {},
): Promise<Harness> {
  const bot = options.bot ?? buildBot(options.setup)
  const h = await createHarness(
    {},
    { bot, ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }) },
  )
  harnesses.push(h)
  bot.now = () => h.clock.now()
  const connected = await h.call('connect', { port: 34231 })
  if (connected.isError) throw new Error(connected.text)
  await h.call('wait_for_chat', { timeout_seconds: 1 })
  return h
}

/** Lets fake time pass, and everything that waits on it, until the condition holds. */
async function pumpUntil(h: Harness, done: () => boolean, maxSteps = 400): Promise<void> {
  for (let step = 0; step < maxSteps && !done(); step += 1) {
    h.scheduler.advance(500)
    await h.settle()
  }
  if (!done()) throw new Error('The condition never became true while time passed.')
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
const data = (result: { data: unknown }): Record<string, unknown> =>
  result.data as Record<string, unknown>

/** What a server does when the bot dies: the items fall where it stood, then it respawns at the spawn point. */
function die(bot: FakeBot, where = DEATH, cause = 'ClaudeBot was slain by Zombie'): void {
  bot.entity = { position: where }
  bot.health = 0
  bot.emit('death')
  bot.emit('messagestr', cause)
  bot.inventoryItems.forEach((item, index) => {
    bot.dropItem(item.name, item.count, { x: where.x + (index % 3) - 1, y: 64.3, z: where.z + 1 })
  })
  bot.inventoryItems = []
  bot.slots.fill(null)
  bot.health = 20
  bot.entity = { position: SPAWN }
  bot.emit('respawn')
}

const carrying = (bot: FakeBot) => {
  bot.inventoryItems = [
    { name: 'iron_ingot', count: 20 },
    { name: 'cobblestone', count: 64 },
    { name: 'iron_pickaxe', count: 1 },
  ]
}

const eventsOf = (h: Harness, type: string) =>
  h.app.inbox
    .drain()
    .events.filter((event) => event.type === type)
    .map((event) => event.message)

describe('recovering dropped items through the MCP server', () => {
  it('the bot dies, says where, walks back by itself, and picks everything up', async () => {
    const h = await start({ setup: carrying })
    const heard: string[] = []

    die(h.bot)
    await pumpUntil(h, () => h.bot.count('iron_ingot') === 20)
    await pumpUntil(h, () => h.app.tasks.current() === undefined)
    heard.push(...h.app.inbox.drain().events.map((e) => `${e.type}: ${e.message}`))

    expect(h.bot.count('iron_ingot')).toBe(20)
    expect(h.bot.count('cobblestone')).toBe(64)
    expect(h.bot.count('iron_pickaxe')).toBe(1)
    expect(heard.find((line) => line.startsWith('bot_died'))).toContain('40, 64, -5 in overworld')
    expect(heard.find((line) => line.startsWith('bot_died'))).toContain('slain by Zombie')
    expect(heard.find((line) => line.startsWith('drop_recovery'))).toContain('Recovered')
    expect(h.bot.chatLog[0]).toBe(
      'I died at 40, 64, -5 in overworld. I am going back for my items.',
    )
    expect(h.bot.chatLog.at(-1)).toContain('Recovered')

    const listed = await h.call('list_death_records')
    expect(data(listed).records).toMatchObject([
      {
        id: 'drop-1',
        kind: 'death',
        status: 'recovered',
        position: DEATH,
        cause: 'ClaudeBot was slain by Zombie',
        attempts: 1,
      },
    ])
  })

  it('does nothing about a death when the inventory was kept (keepInventory)', async () => {
    const h = await start({ setup: carrying })

    h.bot.entity = { position: DEATH }
    h.bot.emit('death')
    h.bot.entity = { position: SPAWN }
    h.bot.emit('respawn') // nothing was dropped: the inventory is still full
    await pumpUntil(h, () => h.bot.chatLog.length > 0)

    expect(h.bot.chatLog).toEqual(['I died at 40, 64, -5 in overworld, but I kept my things.'])
    expect(data(await h.call('list_death_records')).records).toEqual([])
  })

  it('leaves the items and says where they are when the policy is skip, and fetches them on request', async () => {
    const h = await start({ setup: carrying })
    await h.call('set_drop_recovery_policy', { policy: 'skip', situation: 'death' })

    die(h.bot)
    await pumpUntil(h, () => h.bot.chatLog.length > 0)
    await h.settle()

    expect(h.bot.chatLog[0]).toContain('My items are there')
    expect(h.bot.count('iron_ingot')).toBe(0)
    expect(data(await h.call('list_death_records')).records).toMatchObject([
      { status: 'abandoned', position: DEATH },
    ])
    const briefing = (await h.call('get_session_briefing')).data as {
      standingInstructions: Record<string, string>
    }
    expect(briefing.standingInstructions.drop_recovery_policy).toContain('death')

    const fetched = await call(h, 'recover_drops', { wait_seconds: 55 })

    expect(data(fetched)).toMatchObject({
      status: 'succeeded',
      result: {
        status: 'recovered',
        recovered: [
          { name: 'cobblestone', count: 64 },
          { name: 'iron_ingot', count: 20 },
          { name: 'iron_pickaxe', count: 1 },
        ],
        missing: [],
      },
    })
    expect(h.bot.count('iron_ingot')).toBe(20)
  })

  it('remembers a death across a restart and offers the recovery in the briefing', async () => {
    const first = await start({ setup: carrying })
    await first.call('set_drop_recovery_policy', { policy: 'skip', situation: 'death' })
    die(first.bot)
    await pumpUntil(first, () => first.bot.chatLog.length > 0)
    await first.settle()
    await first.close()

    // A new run of the server, in the same world: the items still lie there.
    const second = await start({
      dataDir: first.dataDir,
      setup: (bot) => {
        bot.dropItem('iron_ingot', 20, { x: 40, y: 64.3, z: -4 })
      },
    })

    const briefing = (await second.call('get_session_briefing')).data as {
      pendingDrops: { id: string; position: unknown }[]
      nextSteps: string[]
    }
    expect(briefing.pendingDrops).toMatchObject([{ id: 'drop-1', position: DEATH }])
    expect(briefing.nextSteps.join(' ')).toContain('recover_drops')

    const fetched = await call(second, 'recover_drops', { wait_seconds: 55 })
    expect(data(fetched)).toMatchObject({ status: 'succeeded' })
    expect(second.bot.count('iron_ingot')).toBe(20)
  })

  it('does not go for items that vanished while the server was off', async () => {
    const first = await start({ setup: carrying })
    await first.call('set_drop_recovery_policy', { policy: 'skip', situation: 'death' })
    die(first.bot)
    await pumpUntil(first, () => first.bot.chatLog.length > 0)
    await first.settle()
    await first.close()
    const second = await start({ dataDir: first.dataDir })
    second.clock.advance(6 * 60_000)

    const briefing = (await second.call('get_session_briefing')).data as { pendingDrops: unknown[] }
    const fetched = await second.call('recover_drops', { wait_seconds: 5 })

    expect(briefing.pendingDrops).toEqual([])
    expect(fetched.isError).toBe(true)
  })
})

describe('recovering from a dangerous place', () => {
  const lavaBeside = (bot: FakeBot) => {
    carrying(bot)
    // Two blocks from the death spot: a hazard the bot must ask about, but not right next to where it walks.
    bot.setBlock(at(40, -7), 'lava')
  }

  it('pauses and asks when the spot has lava next to it, and goes on when the player agrees', async () => {
    const h = await start({ setup: lavaBeside })
    await h.call('set_drop_recovery_policy', { policy: 'skip', situation: 'death' })
    die(h.bot)
    await pumpUntil(h, () => h.bot.chatLog.length > 0)
    h.app.inbox.drain()

    const started = await call(h, 'recover_drops', { wait_seconds: 20 })

    expect(data(started)).toMatchObject({
      status: 'waiting_for_input',
      waitingFor: { options: ['try_carefully', 'abandon'] },
    })
    expect(JSON.stringify(data(started))).toContain('lava within 2 blocks')
    expect(eventsOf(h, 'needs_decision')[0]).toContain('looks dangerous')
    expect(h.bot.count('iron_ingot')).toBe(0)

    await call(h, 'resume_task', { decision: 'try_carefully' })
    await pumpUntil(h, () => h.app.tasks.current() === undefined)

    expect(h.app.tasks.latest()).toMatchObject({ status: 'succeeded' })
    expect(h.bot.count('iron_ingot')).toBe(20)
  })

  it('leaves the items and keeps the coordinates when the player says to abandon', async () => {
    const h = await start({ setup: lavaBeside })
    await h.call('set_drop_recovery_policy', { policy: 'skip', situation: 'death' })
    die(h.bot)
    await pumpUntil(h, () => h.bot.chatLog.length > 0)
    await call(h, 'recover_drops', { wait_seconds: 20 })

    await call(h, 'resume_task', { decision: 'abandon' })
    await pumpUntil(h, () => h.app.tasks.current() === undefined)

    const finished = h.app.tasks.latest()
    expect(finished).toMatchObject({ status: 'failed', failure: { reason: 'abandoned' } })
    expect(finished?.failure?.message).toContain('40, 64, -5')
    expect(h.bot.count('iron_ingot')).toBe(0)
    expect(data(await h.call('list_death_records')).records).toMatchObject([
      { status: 'abandoned', position: DEATH },
    ])
  })

  it('skip_drop_recovery cancels a recovery that waits for an answer and returns the coordinates', async () => {
    const h = await start({ setup: lavaBeside })
    await h.call('set_drop_recovery_policy', { policy: 'skip', situation: 'death' })
    die(h.bot)
    await pumpUntil(h, () => h.bot.chatLog.length > 0)
    await call(h, 'recover_drops', { wait_seconds: 20 })

    const skipped = await call(h, 'skip_drop_recovery')

    expect(data(skipped)).toMatchObject({
      skipped: [{ id: 'drop-1', status: 'abandoned', position: DEATH }],
    })
    expect(h.app.tasks.current()).toBeUndefined()
    expect(h.bot.count('iron_ingot')).toBe(0)
  })
})

describe('items nobody picked up after a handover', () => {
  const rich = (bot: FakeBot) => {
    bot.inventoryItems = [{ name: 'iron_ingot', count: 8 }]
  }

  async function giveAndLeave(h: Harness, extra: Record<string, unknown> = {}) {
    const given = await call(h, 'give_items', {
      items: [{ item: 'iron_ingot', count: 8 }],
      wait_seconds: 55,
      ...extra,
    })
    expect(data(given)).toMatchObject({
      status: 'succeeded',
      result: { unclaimed: [{ count: 8 }] },
    })
  }

  it('takes them back after a minute, and says so', async () => {
    const h = await start({ setup: rich })
    await giveAndLeave(h)
    expect(h.bot.count('iron_ingot')).toBe(0)
    h.app.inbox.drain()

    await pumpUntil(h, () => h.bot.count('iron_ingot') === 8, 400)
    await pumpUntil(h, () => h.app.tasks.current() === undefined)

    expect(h.bot.chatLog.at(-1)).toContain('Recovered 8 iron_ingot')
    expect(data(await h.call('list_death_records')).records).toMatchObject([
      { kind: 'unclaimed', status: 'recovered' },
    ])
  })

  it('leaves them where they are when the call says so, and keeps the coordinates', async () => {
    const h = await start({ setup: rich })
    await giveAndLeave(h, { recollect_unclaimed: false })

    for (let i = 0; i < 200; i += 1) {
      h.scheduler.advance(500)
      await h.settle()
    }

    expect(h.bot.count('iron_ingot')).toBe(0)
    expect(data(await h.call('list_death_records')).records).toMatchObject([
      { kind: 'unclaimed', status: 'abandoned', note: 'Left on the ground on purpose.' },
    ])
  })

  it('follows the standing policy when the call says nothing', async () => {
    const h = await start({ setup: rich })
    await h.call('set_drop_recovery_policy', { policy: 'skip', situation: 'unclaimed' })
    await giveAndLeave(h)

    for (let i = 0; i < 200; i += 1) {
      h.scheduler.advance(500)
      await h.settle()
    }

    expect(h.bot.count('iron_ingot')).toBe(0)
  })

  it('skip_drop_recovery before the minute is over cancels the plan', async () => {
    const h = await start({ setup: rich })
    await giveAndLeave(h)

    const skipped = await call(h, 'skip_drop_recovery')
    for (let i = 0; i < 200; i += 1) {
      h.scheduler.advance(500)
      await h.settle()
    }

    expect(data(skipped)).toMatchObject({ skipped: [{ kind: 'unclaimed', status: 'abandoned' }] })
    expect(h.bot.count('iron_ingot')).toBe(0)
  })
})
