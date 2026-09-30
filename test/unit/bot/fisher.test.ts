import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerFisher } from '../../../src/bot/mineflayer-fisher.js'
import { FakeBot } from '../../fakes/fake-bot.js'

const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})

function withRod() {
  const bot = new FakeBot().useGameData()
  bot.addItems('fishing_rod', 1)
  return bot
}

describe('MineflayerFisher', () => {
  it('takes the rod in hand, casts, and returns when the fish bites', async () => {
    const bot = withRod()

    const result = await new MineflayerFisher(holderOf(bot)).cast(new AbortController().signal)

    expect(result).toEqual({ ok: true, value: undefined })
    expect(bot.fishCalls).toBe(1)
    expect(bot.equipped).toHaveLength(1)
  })

  it('reels the line in when the signal aborts while waiting for a bite', async () => {
    const bot = withRod()
    bot.fishScript = ['never']
    const controller = new AbortController()

    const pending = new MineflayerFisher(holderOf(bot)).cast(controller.signal)
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort()

    expect(await pending).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(bot.activated).toHaveLength(1)
  })

  it('does not cast when it is already cancelled', async () => {
    const bot = withRod()
    const controller = new AbortController()
    controller.abort()

    const result = await new MineflayerFisher(holderOf(bot)).cast(controller.signal)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(bot.fishCalls).toBe(0)
  })

  it('reports a cast that failed for another reason', async () => {
    const bot = withRod()
    bot.fishScript = ['error']

    const result = await new MineflayerFisher(holderOf(bot)).cast(new AbortController().signal)

    expect(result).toMatchObject({ ok: false, error: { reason: 'failed' } })
  })

  it('fails no_rod when the rod cannot be taken in hand', async () => {
    const bot = withRod()
    bot.failEquip = new Error('no such item')

    const result = await new MineflayerFisher(holderOf(bot)).cast(new AbortController().signal)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_rod' } })
  })

  it('fails when this game version has no rod', async () => {
    const bot = new FakeBot()
    bot.registry = { ...bot.registry, itemsByName: {} }

    const result = await new MineflayerFisher(holderOf(bot)).cast(new AbortController().signal)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_rod' } })
  })

  it('fails when not connected', async () => {
    const result = await new MineflayerFisher(holderOf(undefined)).cast(
      new AbortController().signal,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
  })
})
