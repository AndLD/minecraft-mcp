import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerBedAccess } from '../../../src/bot/mineflayer-bed-access.js'
import { MineflayerSleeper } from '../../../src/bot/mineflayer-sleeper.js'
import { classifySleepFailure } from '../../../src/bot/sleep-failure.js'
import { FakeBot } from '../../fakes/fake-bot.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { AutoScheduler } from '../../fakes/gathering-fakes.js'

const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})
const bed = { x: 4, y: 64, z: 4 }
const signal = (): AbortSignal => new AbortController().signal

function botWithBed(timeOfDay: number) {
  const bot = new FakeBot()
  bot.time.timeOfDay = timeOfDay
  bot.setBlock(bed, 'red_bed')
  return bot
}

describe('classifySleepFailure', () => {
  it.each([
    ['You may not rest now, there are monsters nearby', 'monsters_nearby'],
    ["it's not night and it's not a thunderstorm", 'not_night'],
    ['You can sleep only at night or during thunderstorms', 'not_night'],
    ['The bed is too far away', 'too_far'],
    ['This bed is occupied', 'occupied'],
    ['Your bed is obstructed', 'obstructed'],
    ['not a bed', 'not_a_bed'],
    ['something else', 'failed'],
  ])('%s is %s', (text, reason) => {
    expect(classifySleepFailure(text)).toBe(reason)
  })
})

describe('MineflayerSleeper', () => {
  it('lies down in a bed at night and gets up again', async () => {
    const bot = botWithBed(14_000)
    const sleeper = new MineflayerSleeper(holderOf(bot))

    expect(await sleeper.sleep(bed)).toEqual({ ok: true, value: undefined })
    expect(sleeper.isSleeping()).toBe(true)
    expect(bot.sleepCalls).toEqual([bed])

    await sleeper.wake()
    expect(sleeper.isSleeping()).toBe(false)
    expect(bot.wakeCalls).toBe(1)
    await sleeper.wake()
    expect(bot.wakeCalls).toBe(1)
  })

  it('reports why the game refused: by day, or with monsters near (from the action bar)', async () => {
    const day = botWithBed(6000)
    expect(await new MineflayerSleeper(holderOf(day)).sleep(bed)).toMatchObject({
      ok: false,
      error: { reason: 'not_night' },
    })

    const night = botWithBed(14_000)
    night.sleepRefusal = 'You may not rest now, there are monsters nearby'
    const result = await new MineflayerSleeper(holderOf(night)).sleep(bed)
    expect(result).toMatchObject({ ok: false, error: { reason: 'monsters_nearby' } })
    expect(night.listenerCount('actionBar')).toBe(0)
    expect(night.listenerCount('messagestr')).toBe(0)
  })

  it('refuses a block that is not a bed, and when not connected', async () => {
    const bot = botWithBed(14_000)
    bot.setBlock(bed, 'stone')
    expect(await new MineflayerSleeper(holderOf(bot)).sleep(bed)).toMatchObject({
      ok: false,
      error: { reason: 'not_a_bed' },
    })
    bot.setBlock({ x: 9, y: 64, z: 9 }, 'air')
    expect(await new MineflayerSleeper(holderOf(bot)).sleep({ x: 50, y: 64, z: 50 })).toMatchObject({
      ok: false,
      error: { reason: 'not_a_bed' },
    })
    const none = new MineflayerSleeper(holderOf(undefined))
    expect(await none.sleep(bed)).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
    expect(none.isSleeping()).toBe(false)
    await none.wake()
  })

  it('does not mind a wake request that arrives after the bot is already up', async () => {
    const bot = botWithBed(14_000)
    bot.isSleeping = true
    bot.wake = () => Promise.reject(new Error('not sleeping'))
    await expect(new MineflayerSleeper(holderOf(bot)).wake()).resolves.toBeUndefined()
  })
})

describe('MineflayerBedAccess', () => {
  const access = (bot: BotLike | undefined) =>
    new MineflayerBedAccess(holderOf(bot), new AutoScheduler(new FakeClock(0)))

  it('reads a bed block, and nothing else', () => {
    const bot = botWithBed(6000)
    bot.setBedPart(bed, 'head')

    expect(access(bot).stateAt(bed)).toEqual({ name: 'red_bed', part: 'head', occupied: false })
    expect(access(bot).stateAt({ x: 0, y: 64, z: 0 })).toBeUndefined()
    bot.setBlock({ x: 1, y: 64, z: 1 }, 'stone')
    expect(access(bot).stateAt({ x: 1, y: 64, z: 1 })).toBeUndefined()
    expect(access(undefined).stateAt(bed)).toBeUndefined()
  })

  it('right-clicks the bed and returns what the server said', async () => {
    const bot = botWithBed(6000)

    const result = await access(bot).use(bed, signal())

    expect(result).toEqual({ ok: true, value: ['Respawn point set'] })
    expect(bot.bedsUsed).toEqual([bed])
    expect(bot.listenerCount('messagestr')).toBe(0)
  })

  it('returns no lines when the server says nothing, and fails cleanly', async () => {
    const quiet = botWithBed(6000)
    quiet.bedRefusesRespawn = true
    expect(await access(quiet).use(bed, signal())).toEqual({ ok: true, value: [] })

    expect(await access(undefined).use(bed, signal())).toMatchObject({
      ok: false,
      error: { reason: 'not_connected' },
    })
    expect(await access(quiet).use({ x: 99, y: 64, z: 99 }, signal())).toMatchObject({
      ok: false,
      error: { reason: 'out_of_reach' },
    })
    const broken = botWithBed(6000)
    broken.activateBlock = () => Promise.reject(new Error('click failed'))
    expect(await access(broken).use(bed, signal())).toMatchObject({
      ok: false,
      error: { reason: 'failed', message: 'click failed' },
    })
  })
})
