import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerMinecarts } from '../../../src/bot/mineflayer-minecarts.js'
import { FakeBot } from '../../fakes/fake-bot.js'

const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})

const at = { x: 3, y: 64, z: 5 }
const signal = (): AbortSignal => new AbortController().signal

function withRail() {
  const bot = new FakeBot().useGameData()
  bot.setBlock(at, 'powered_rail')
  bot.addItems('minecart', 2)
  return bot
}

describe('MineflayerMinecarts', () => {
  it('equips a minecart and right-clicks the rail, and sees the cart appear', async () => {
    const bot = withRail()
    const carts = new MineflayerMinecarts(holderOf(bot))

    const result = await carts.place(at, signal())

    expect(result).toEqual({ ok: true, value: undefined })
    expect(bot.minecartsPlaced).toEqual([at])
    expect(bot.activateBlockCalls).toEqual([at])
    expect(Object.values(bot.entities).some((e) => e.name === 'minecart')).toBe(true)
  })

  it.each([
    ['not_connected', () => new MineflayerMinecarts(holderOf(undefined))],
    [
      'no_minecart',
      () => {
        const bot = new FakeBot().useGameData()
        bot.setBlock(at, 'rail')
        return new MineflayerMinecarts(holderOf(bot))
      },
    ],
    [
      'out_of_reach',
      () => {
        const bot = new FakeBot().useGameData()
        bot.addItems('minecart', 1)
        return new MineflayerMinecarts(holderOf(bot))
      },
    ],
    [
      'not_a_rail',
      () => {
        const bot = new FakeBot().useGameData()
        bot.setBlock(at, 'stone')
        bot.addItems('minecart', 1)
        return new MineflayerMinecarts(holderOf(bot))
      },
    ],
  ])('reports %s', async (reason, make) => {
    const result = await make().place(at, signal())

    expect(result).toMatchObject({ ok: false, error: { reason } })
  })

  it('fails cleanly when the click throws', async () => {
    const bot = withRail()
    bot.activateBlock = () => Promise.reject(new Error('too far away'))

    const result = await new MineflayerMinecarts(holderOf(bot)).place(at, signal())

    expect(result).toEqual({ ok: false, error: { reason: 'failed', message: 'too far away' } })
  })

  it('fails when no cart appears, and when cancelled while waiting', async () => {
    const bot = withRail()
    bot.activateBlock = () => Promise.resolve()
    const none = await new MineflayerMinecarts(holderOf(bot)).place(at, signal())
    const controller = new AbortController()
    controller.abort()
    const cancelled = await new MineflayerMinecarts(holderOf(bot)).place(at, controller.signal)

    expect(none).toMatchObject({ ok: false, error: { reason: 'failed', message: expect.stringContaining('No minecart appeared') } })
    expect(cancelled).toMatchObject({ ok: false, error: { message: 'Cancelled.' } })
  })
})
