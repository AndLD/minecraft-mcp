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

    bot.foodSaturation = 2.5
    bot.oxygenLevel = 11

    expect(new MineflayerVitals(holderOf(bot)).read()).toEqual({
      health: 14,
      food: 9,
      saturation: 2.5,
      oxygen: 11,
      inLava: false,
      inWater: false,
      headUnderwater: false,
      position: { x: 1.5, y: 70, z: -3 },
      dimension: 'the_nether',
      timeOfDay: 18000,
    })
  })

  describe('liquids', () => {
    const at = { x: 5.5, y: 64, z: 5.5 }
    function botIn(feet: string | undefined, head: string | undefined): FakeBot {
      const bot = new FakeBot()
      bot.entity = { position: at }
      if (feet !== undefined) bot.setBlock({ x: 5, y: 64, z: 5 }, feet)
      if (head !== undefined) bot.setBlock({ x: 5, y: 65, z: 5 }, head)
      return bot
    }

    it('is in lava when the block at the feet is lava', () => {
      expect(new MineflayerVitals(holderOf(botIn('lava', 'air'))).read()).toMatchObject({
        inLava: true,
        inWater: false,
      })
    })

    it('is in water, and can drown only when the head is under water', () => {
      expect(new MineflayerVitals(holderOf(botIn('water', 'air'))).read()).toMatchObject({
        inWater: true,
        headUnderwater: false,
      })
      expect(new MineflayerVitals(holderOf(botIn('water', 'water'))).read()).toMatchObject({
        inWater: true,
        headUnderwater: true,
      })
    })

    it('is on dry land when the blocks are unloaded or air', () => {
      expect(new MineflayerVitals(holderOf(botIn(undefined, undefined))).read()).toMatchObject({
        inLava: false,
        inWater: false,
        headUnderwater: false,
      })
      expect(new MineflayerVitals(holderOf(botIn('air', 'air'))).read()).toMatchObject({
        inLava: false,
        inWater: false,
      })
    })
  })
})
