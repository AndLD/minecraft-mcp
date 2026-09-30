import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from '@jest/globals'
import { ANIMAL_KEYS, FakeBot } from '../fakes/fake-bot.js'
import { createHarness, type Harness } from './support/app-harness.js'

const opened: Harness[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const harness of opened.splice(0)) await harness.close().catch(() => undefined)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The bot stands at (10, 64, -5) on a flat dirt floor. */
const HERE = { x: 10, y: 64, z: -5 }
const at = (x: number, z = -5) => ({ x, y: 64, z })

function flatFloor(bot: FakeBot, radius = 25): void {
  for (let x = HERE.x - radius; x <= HERE.x + radius; x += 1) {
    for (let z = HERE.z - radius; z <= HERE.z + radius; z += 1) {
      bot.setBlock({ x, y: 63, z }, 'dirt')
      bot.setBlock({ x, y: 62, z }, 'dirt')
      for (let y = 64; y <= 68; y += 1) bot.setBlock({ x, y, z }, 'air')
    }
  }
}

const tree = (bot: FakeBot, x: number, z: number, height: number): void => {
  for (let y = 64; y < 64 + height; y += 1) bot.setBlock({ x, y, z }, 'oak_log')
}

async function start(
  setup: (bot: FakeBot) => void = () => undefined,
  options: { dataDir?: string } = {},
): Promise<Harness> {
  const bot = new FakeBot().useGameData()
  flatFloor(bot)
  setup(bot)
  const h = await createHarness(
    {},
    { bot, ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }) },
  )
  opened.push(h)
  if (!dirs.includes(h.dataDir)) dirs.push(h.dataDir)
  bot.now = () => h.clock.now()
  const connected = await h.call('connect', { port: 34231 })
  if (connected.isError) throw new Error(connected.text)
  await h.call('wait_for_chat', { timeout_seconds: 1 })
  return h
}

/** Lets time pass in small steps until the call finishes, since walking and pickups wait on the fake scheduler. */
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
const task = (result: { data: unknown }): Record<string, unknown> => data(result)

describe('containers, rules, and depositing', () => {
  const chests = (bot: FakeBot): void => {
    for (const x of [16, 22, 28]) bot.setBlock(at(x), 'chest')
  }

  it('routes items to chests by rule, keeps the gear, and remembers everything across a restart', async () => {
    const h = await start((bot) => {
      chests(bot)
      bot.inventoryItems = [
        { name: 'cobblestone', count: 100 },
        { name: 'raw_iron', count: 12 },
        { name: 'iron_ingot', count: 3 },
        { name: 'feather', count: 5 },
        { name: 'iron_pickaxe', count: 1 },
        { name: 'cooked_beef', count: 8 },
      ]
    })

    expect(
      (await h.call('register_container', { x: 16, y: 64, z: -5, label: 'stone' })).isError,
    ).toBe(false)
    expect(
      (await h.call('register_container', { x: 22, y: 64, z: -5, label: 'metal' })).isError,
    ).toBe(false)
    expect(
      (await h.call('register_container', { x: 28, y: 64, z: -5, label: 'misc' })).isError,
    ).toBe(false)
    await h.call('set_storage_rule', { container: 'stone', items: ['stone', 'cobblestone'] })
    await h.call('set_storage_rule', { container: 'metal', items: ['ores', 'ingots'] })
    await h.call('set_storage_rule', { container: 'misc', items: ['*'], priority: -10 })

    const result = await call(h, 'deposit_items', { wait_seconds: 30 })

    expect(task(result)).toMatchObject({ status: 'succeeded', result: { leftover: [] } })
    expect(h.bot.inContainer(at(16), 'cobblestone')).toBe(100)
    expect(h.bot.inContainer(at(22), 'raw_iron')).toBe(12)
    expect(h.bot.inContainer(at(22), 'iron_ingot')).toBe(3)
    expect(h.bot.inContainer(at(28), 'feather')).toBe(5)
    expect(h.bot.count('iron_pickaxe')).toBe(1)
    expect(h.bot.count('cooked_beef')).toBe(8)

    const listed = data(await h.call('list_containers')) as {
      containers: { label: string; items: { name: string }[] }[]
    }
    expect(listed.containers.map((c) => c.label)).toEqual(['stone', 'metal', 'misc'])
    expect(listed.containers[1]?.items.map((i) => i.name).sort()).toEqual([
      'iron_ingot',
      'raw_iron',
    ])

    // A restart: the same world, a fresh app on the same state directory.
    await h.close()
    const again = await start(
      (bot) => {
        chests(bot)
      },
      { dataDir: h.dataDir },
    )
    const rules = data(await again.call('list_storage_rules')) as {
      rules: { containerLabel: string; specs: string[] }[]
    }
    const containers = data(await again.call('list_containers')) as {
      containers: { label: string }[]
    }

    expect(rules.rules.map((r) => [r.containerLabel, r.specs])).toEqual([
      ['stone', ['stone', 'cobblestone']],
      ['metal', ['ores', 'ingots']],
      ['misc', ['*']],
    ])
    expect(containers.containers.map((c) => c.label)).toEqual(['stone', 'metal', 'misc'])
  })

  it('finds an item across several chests, and withdraws it', async () => {
    const h = await start((bot) => {
      chests(bot)
      bot.stock(at(16), 'iron_ingot', 20)
      bot.stock(at(22), 'iron_ingot', 5)
      bot.stock(at(28), 'coal', 9)
    })
    await h.call('register_container', { x: 16, y: 64, z: -5, label: 'a' })

    const found = await call(h, 'find_items', { item: 'iron_ingot', wait_seconds: 30 })

    // Nothing was remembered about the chests, so it looked into them (and found the two nobody had registered).
    expect(task(found)).toMatchObject({ status: 'succeeded', result: { total: 25, scanned: true } })
    const again = await call(h, 'find_items', { item: 'iron_ingot', wait_seconds: 30 })
    expect(task(again)).toMatchObject({ result: { total: 25, scanned: false } })

    const taken = await call(h, 'withdraw_items', {
      items: [{ item: 'iron_ingot', count: 23 }],
      wait_seconds: 30,
    })

    expect(task(taken)).toMatchObject({
      status: 'succeeded',
      result: { withdrawn: [{ name: 'iron_ingot', count: 23 }], shortfall: [] },
    })
    expect(h.bot.count('iron_ingot')).toBe(23)
    expect(h.bot.inContainer(at(16), 'iron_ingot') + h.bot.inContainer(at(22), 'iron_ingot')).toBe(
      2,
    )
  })

  it('organizes what is in the chests: plans first, moves after the second call, and spares a protected chest', async () => {
    const h = await start((bot) => {
      chests(bot)
      bot.stock(at(28), 'cobblestone', 100)
      bot.stock(at(28), 'raw_iron', 12)
      bot.stock(at(28), 'feather', 5)
      bot.stock(at(16), 'diamond', 9)
      bot.inventoryItems = [{ name: 'iron_pickaxe', count: 1 }]
    })
    await h.call('register_container', { x: 16, y: 64, z: -5, label: 'treasure', protected: true })
    await h.call('register_container', { x: 22, y: 64, z: -5, label: 'metal' })
    await h.call('register_container', { x: 28, y: 64, z: -5, label: 'misc' })
    await h.call('set_storage_rule', { container: 'metal', items: ['ores', 'cobblestone'] })
    await h.call('set_storage_rule', { container: 'treasure', items: ['diamond', 'feather'] })

    const plan = await call(h, 'organize_storage', { wait_seconds: 30 })

    expect(task(plan)).toMatchObject({
      status: 'succeeded',
      result: { dryRun: true, moved: 0, skipped: [{ reason: 'protected' }] },
    })
    expect(h.bot.inContainer(at(28), 'cobblestone')).toBe(100)
    expect(h.bot.inContainer(at(22), 'cobblestone')).toBe(0)

    const real = await call(h, 'organize_storage', { dry_run: false, wait_seconds: 30 })

    expect(task(real)).toMatchObject({
      status: 'succeeded',
      result: { dryRun: false, moved: 112, left: [], carried: [] },
    })
    expect(h.bot.inContainer(at(22), 'cobblestone')).toBe(100)
    expect(h.bot.inContainer(at(22), 'raw_iron')).toBe(12)
    expect(h.bot.inContainer(at(28), 'feather')).toBe(5) // its rule points at a protected chest: stays
    expect(h.bot.inContainer(at(16), 'diamond')).toBe(9)
    expect(h.bot.inContainer(at(16), 'feather')).toBe(0)
    expect(h.bot.count('iron_pickaxe')).toBe(1)
    const listed = data(await h.call('list_containers')) as {
      containers: { label: string; items: { name: string; count: number }[] }[]
    }
    const metal = listed.containers.find((container) => container.label === 'metal')
    expect(metal?.items).toContainEqual({ name: 'cobblestone', count: 100 })
  })

  it('never touches a protected chest', async () => {
    const h = await start((bot) => {
      chests(bot)
      bot.stock(at(16), 'diamond', 12)
      bot.inventoryItems = [{ name: 'dirt', count: 10 }]
    })
    await h.call('register_container', { x: 16, y: 64, z: -5, label: 'treasure', protected: true })

    const deposit = await call(h, 'deposit_items', { container: 'treasure' })
    const withdraw = await call(h, 'withdraw_items', {
      items: [{ item: 'diamond' }],
      container: 'treasure',
    })

    expect(deposit.isError).toBe(true)
    expect(deposit.text).toContain('protected')
    expect(withdraw.isError).toBe(true)
    expect(h.bot.inContainer(at(16), 'diamond')).toBe(12)
    expect(h.bot.count('dirt')).toBe(10)
  })
})

describe('a full inventory during a task', () => {
  /** Two slots: one holds dirt, the first log takes the other. */
  const cramped = (bot: FakeBot): void => {
    tree(bot, 14, -5, 4)
    bot.setBlock(at(18, -3), 'chest')
    bot.slotLimit = 2
    bot.inventoryItems = [{ name: 'dirt', count: 64 }]
  }

  it('pauses and asks, and carries on after the answer "offload"', async () => {
    const h = await start((bot) => {
      cramped(bot)
      bot.slotLimit = 1 // full from the start
    })

    const first = await call(h, 'collect_block', {
      blocks: ['oak_log'],
      count: 2,
      wait_seconds: 30,
    })

    expect(task(first)).toMatchObject({
      status: 'waiting_for_input',
      waitingFor: { options: ['offload', 'continue', 'stop'] },
    })
    const events = (await h.call('wait_for_chat', { timeout_seconds: 1 })).data as {
      events: { type: string; message: string }[]
    }
    expect(
      events.events.some((e) => e.type === 'needs_decision' && e.message.includes('resume_task')),
    ).toBe(true)
    expect(h.bot.dug).toEqual([])

    const wrong = await h.call('resume_task', { decision: 'dance' })
    expect(wrong.isError).toBe(true)
    h.bot.slotLimit = 2
    await h.call('resume_task', { decision: 'offload' })
    await pumped(
      h,
      (async () => {
        for (let i = 0; i < 60; i += 1) await h.settle()
      })(),
    )

    const status = data(await h.call('get_task_status')).task
    expect(status).toMatchObject({ status: 'succeeded', result: { mined: 2 } })
    expect(h.bot.inContainer(at(18, -3), 'dirt')).toBe(64)
    expect(h.bot.count('oak_log')).toBe(2)
  })

  it('stops with what it has when the answer is "stop"', async () => {
    const h = await start((bot) => {
      cramped(bot)
      bot.slotLimit = 1
    })
    await call(h, 'collect_block', { blocks: ['oak_log'], count: 2, wait_seconds: 30 })

    await h.call('resume_task', { decision: 'stop' })
    await pumped(
      h,
      (async () => {
        for (let i = 0; i < 20; i += 1) await h.settle()
      })(),
    )

    const status = data(await h.call('get_task_status')).task as {
      status: string
      failure: { reason: string }
    }
    expect(status).toMatchObject({ status: 'failed', failure: { reason: 'inventory_full' } })
  })

  it('offloads by itself, again and again, under the "offload_and_return" policy, and finishes the job', async () => {
    const h = await start(cramped)
    await h.call('set_storage_policy', { policy: 'offload_and_return' })

    const result = await call(h, 'collect_block', {
      blocks: ['oak_log'],
      count: 4,
      wait_seconds: 55,
    })

    expect(task(result)).toMatchObject({ status: 'succeeded', result: { mined: 4 } })
    expect(h.bot.inContainer(at(18, -3), 'dirt')).toBe(64)
    expect(h.bot.inContainer(at(18, -3), 'oak_log') + h.bot.count('oak_log')).toBe(4)
    const briefing = await h.call('get_session_briefing')
    expect(briefing.text).toContain('takes things to the chests')
  })

  it('takes the policy from the call: "offload_and_return" on one call only', async () => {
    const h = await start(cramped)

    const result = await call(h, 'collect_block', {
      blocks: ['oak_log'],
      count: 3,
      wait_seconds: 55,
      on_inventory_full: 'offload_and_return',
    })

    expect(task(result)).toMatchObject({ status: 'succeeded', result: { mined: 3 } })
  })

  it('asks instead when there is no chest to offload into', async () => {
    const h = await start((bot) => {
      tree(bot, 14, -5, 4)
      bot.slotLimit = 1
      bot.inventoryItems = [{ name: 'dirt', count: 64 }]
    })
    await h.call('set_storage_policy', { policy: 'offload_and_return' })

    const result = await call(h, 'collect_block', {
      blocks: ['oak_log'],
      count: 2,
      wait_seconds: 30,
    })

    expect(task(result)).toMatchObject({ status: 'waiting_for_input' })
    expect((task(result).waitingFor as { message: string }).message).toContain('Could not offload')
  })
})

describe('hunting and storage', () => {
  it('deposits the cooked meat by the food rule when asked to', async () => {
    const h = await start((bot) => {
      const cows = [11.5, 12, 12, 10].map((x, i) => ({
        id: 200 + i,
        type: 'animal',
        name: 'cow',
        position: { x, y: 64, z: [-5, -6, -4, -3][i] ?? -5 },
        metadata: ANIMAL_KEYS.map(() => undefined),
      }))
      for (const cow of cows) bot.entities[String(cow.id)] = cow
      bot.onAttack = (target) => {
        const dead = bot.entities[String(target.id)]
        if (dead === undefined) return
        bot.entities[String(target.id)] = { ...dead, isDead: true }
        bot.dropItem('beef', 2, { x: dead.position.x, y: 64.3, z: dead.position.z })
      }
      bot.setBlock(at(20, -8), 'chest')
      bot.inventoryItems = [
        { name: 'furnace', count: 1 },
        { name: 'coal', count: 2 },
      ]
    })
    await h.call('register_container', { x: 20, y: 64, z: -8, label: 'food' })
    await h.call('set_storage_rule', { container: 'food', items: ['food'] })

    const result = await call(h, 'hunt_animals', {
      species: ['cow'],
      count: 1,
      cook: true,
      deposit_cooked: true,
      wait_seconds: 55,
    })

    expect(task(result)).toMatchObject({
      status: 'succeeded',
      result: { killed: 1, deposited: [{ container: 'container-1' }] },
    })
    expect(h.bot.inContainer(at(20, -8), 'cooked_beef')).toBe(2)
    expect(h.bot.count('cooked_beef')).toBe(0)
  })
})
