import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerVitals } from '../../../src/bot/mineflayer-vitals.js'
import { FakeBot } from '../../fakes/fake-bot.js'

const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})

describe('MineflayerVitals', () => {
  it('reads nothing without a bot', () => {
    expect(new MineflayerVitals(holderOf(undefined)).read()).toBeUndefined()
  })

  it('reads nothing before the bot has an entity in the world', () => {
    const bot = new FakeBot()
    bot.entity = undefined

    expect(new MineflayerVitals(holderOf(bot)).read()).toBeUndefined()
  })

  it('reads a snapshot with a plain position', () => {
    const bot = new FakeBot()
    bot.health = 14
    bot.food = 9
    bot.game = { dimension: 'the_nether' }
    bot.time = { timeOfDay: 18000 }
    bot.entity = { position: { x: 1.5, y: 70, z: -3 } }

    expect(new MineflayerVitals(holderOf(bot)).read()).toEqual({
      health: 14,
      food: 9,
      position: { x: 1.5, y: 70, z: -3 },
      dimension: 'the_nether',
      timeOfDay: 18000,
    })
  })
})
