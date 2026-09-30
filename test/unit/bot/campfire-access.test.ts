import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerCampfireAccess } from '../../../src/bot/mineflayer-campfire.js'
import { FakeBot } from '../../fakes/fake-bot.js'

const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})
const at = { x: 3, y: 64, z: 5 }

describe('MineflayerCampfireAccess', () => {
  it('reads whether the campfire is lit, out, or not a campfire', () => {
    const bot = new FakeBot()
    const access = new MineflayerCampfireAccess(holderOf(bot))
    expect(access.stateAt(at)).toBe('none')
    bot.setBlock(at, 'campfire')
    expect(access.stateAt(at)).toBe('lit')
    bot.setCampfireOut(at, true)
    expect(access.stateAt(at)).toBe('out')
    bot.setBlock(at, 'soul_campfire')
    bot.setCampfireOut(at, false)
    expect(access.stateAt(at)).toBe('lit')
  })

  it('takes the item in hand and right-clicks the campfire', async () => {
    const bot = new FakeBot()
    bot.setBlock(at, 'campfire')
    bot.addItems('beef', 3)
    const access = new MineflayerCampfireAccess(holderOf(bot))

    const result = await access.put(at, 'beef')

    expect(result).toEqual({ ok: true, value: undefined })
    expect(bot.onCampfire).toMatchObject([{ position: at, item: 'beef' }])
    expect(bot.count('beef')).toBe(2)
  })

  it('fails when the campfire is full', async () => {
    const bot = new FakeBot()
    bot.setBlock(at, 'campfire')
    bot.addItems('beef', 3)
    bot.campfireRoom = 0
    const access = new MineflayerCampfireAccess(holderOf(bot))

    const result = await access.put(at, 'beef')

    expect(result).toMatchObject({ ok: false })
    expect(bot.count('beef')).toBe(3)
  })

  it('fails without a campfire, an unknown item, or a connection', async () => {
    const bot = new FakeBot()
    const access = new MineflayerCampfireAccess(holderOf(bot))
    expect(await access.put(at, 'beef')).toMatchObject({ ok: false })
    bot.setBlock(at, 'campfire')
    expect(await access.put(at, 'not_an_item')).toMatchObject({ ok: false })
    expect(await new MineflayerCampfireAccess(holderOf(undefined)).put(at, 'beef')).toMatchObject({
      ok: false,
    })
  })
})
