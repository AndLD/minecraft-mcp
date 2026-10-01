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
const BED = at(14, GROUND + 1, -6)

async function start(timeOfDay: number, setup: (bot: FakeBot) => void = () => undefined): Promise<Harness> {
  const bot = new FakeBot().useGameData()
  for (let x = -10; x <= 40; x += 1)
    for (let z = -30; z <= 20; z += 1) {
      bot.setBlock(at(x, GROUND, z), 'dirt')
      for (let y = GROUND + 1; y <= GROUND + 4; y += 1) bot.setBlock(at(x, y, z), 'air')
    }
  bot.entity = { position: at(10.5, GROUND + 1, -5.5) }
  bot.time.timeOfDay = timeOfDay
  bot.setBlock(BED, 'red_bed')
  setup(bot)
  const h = await createHarness({}, { bot })
  harness = h
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
const data = (result: { data: unknown }): Record<string, unknown> => result.data as Record<string, unknown>

describe('sleeping through the MCP server', () => {
  it('goes to bed at night, stays until the server skips the night, and remembers the respawn bed', async () => {
    const h = await start(14_000)
    const realSleep = h.bot.sleep.bind(h.bot)
    h.bot.sleep = async (bed) => {
      await realSleep(bed)
      h.scheduler.after(3_000, () => {
        h.bot.time.timeOfDay = 100
        h.bot.isSleeping = false
      })
    }

    const result = await call(h, 'sleep', { wait_seconds: 30 })

    expect(data(result)).toMatchObject({
      status: 'succeeded',
      result: { bed: BED, colour: 'red', nightSkipped: true },
    })
    expect(h.bot.sleepCalls).toEqual([BED])
    const beds = data(await h.call('list_beds'))
    expect(beds['respawnPoint']).toMatchObject({ colour: 'red', respawnPoint: true, intact: true })
  })

  it('tells the agent the night was not skipped when someone else is awake', async () => {
    const h = await start(14_000)

    const result = await call(h, 'sleep', { stay_seconds: 5, wait_seconds: 30 })

    expect(data(result)).toMatchObject({ status: 'succeeded', result: { nightSkipped: false } })
    expect(h.bot.isSleeping).toBe(false)
  })

  it('cannot sleep by day but sets the respawn point, and the game must confirm it', async () => {
    const h = await start(6000)

    const tried = await call(h, 'sleep', { wait_seconds: 30 })
    const set = await call(h, 'set_respawn_point', { wait_seconds: 30 })

    expect(tried.isError).toBe(true)
    expect(tried.text).toContain('not_night')
    expect(data(set)).toMatchObject({ status: 'succeeded', result: { bed: BED } })
    expect(data(await h.call('list_beds'))['respawnPoint']).toMatchObject({ colour: 'red' })

    h.bot.bedRefusesRespawn = true
    const refused = await call(h, 'set_respawn_point', { wait_seconds: 30 })
    expect(refused.text).toContain('not_confirmed')
  })

  it('places a bed it carries and remembers it', async () => {
    const h = await start(6000, (bot) => {
      bot.setBlock(BED, 'air')
      bot.addItems('red_bed', 1)
    })

    const placed = await call(h, 'place_bed', { wait_seconds: 30 })

    expect(data(placed)).toMatchObject({ status: 'succeeded', result: { colour: 'red' } })
    expect((data(await h.call('list_beds'))['beds'] as unknown[]).length).toBe(1)
    const none = await call(h, 'place_bed', { wait_seconds: 30 })
    expect(none.text).toContain('no_bed_item')
  })

  it('never sleeps in the Nether', async () => {
    const h = await start(14_000, (bot) => {
      bot.game = { dimension: 'the_nether' }
    })

    const result = await call(h, 'sleep', { wait_seconds: 30 })

    expect(result.text).toContain('wrong_dimension')
    expect(h.bot.sleepCalls).toEqual([])
  })

  it('saves the sleep policy as a standing instruction the briefing shows', async () => {
    const h = await start(6000)

    await h.call('set_sleep_policy', { policy: 'when_idle' })
    const briefing = await h.call('get_session_briefing')
    expect(JSON.stringify(briefing.data)).toContain('goes to bed by itself')

    await h.call('set_sleep_policy', { policy: 'ask' })
    expect(JSON.stringify((await h.call('get_session_briefing')).data)).not.toContain('goes to bed by itself')
  })

  it('asks the agent at nightfall by default, when a bed is known', async () => {
    const h = await start(6000)
    await call(h, 'set_respawn_point', { wait_seconds: 30 })
    h.bot.time.timeOfDay = 14_000

    h.scheduler.advance(6_000)
    await h.settle()
    const events = await h.call('wait_for_chat', { timeout_seconds: 1 })

    expect(events.text).toContain('needs_decision')
    expect(events.text).toContain('set_sleep_policy')
    expect(h.bot.sleepCalls).toEqual([])
  })

  it('goes to bed by itself when the policy says so and the bot is idle', async () => {
    const h = await start(6000)
    await call(h, 'set_respawn_point', { wait_seconds: 30 })
    await h.call('set_sleep_policy', { policy: 'when_idle' })
    h.bot.time.timeOfDay = 14_000

    for (let i = 0; i < 4; i += 1) {
      h.scheduler.advance(5_000)
      await h.settle()
    }

    expect(h.bot.sleepCalls).toEqual([BED])
  })
})
