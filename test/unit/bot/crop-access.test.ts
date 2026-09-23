import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerCropAccess } from '../../../src/bot/mineflayer-crop-access.js'
import { FakeBot } from '../../fakes/fake-bot.js'

const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})

const at = { x: 3, y: 64, z: 5 }

describe('MineflayerCropAccess', () => {
  it('reads the crop name and age', () => {
    const bot = new FakeBot()
    bot.setBlock(at, 'wheat')
    bot.setCropAge(at, 5)
    const access = new MineflayerCropAccess(holderOf(bot))

    expect(access.stateAt(at)).toEqual({ name: 'wheat', age: 5 })
  })

  it('defaults to age 0 when nobody has grown it', () => {
    const bot = new FakeBot()
    bot.setBlock(at, 'carrots')
    const access = new MineflayerCropAccess(holderOf(bot))

    expect(access.stateAt(at)).toEqual({ name: 'carrots', age: 0 })
  })

  it('is undefined for a block that is not loaded', () => {
    const bot = new FakeBot()
    const access = new MineflayerCropAccess(holderOf(bot))

    expect(access.stateAt(at)).toBeUndefined()
  })

  it('is undefined for a block with no age property (not a crop)', () => {
    const bot = new FakeBot()
    bot.setBlock(at, 'stone')
    const access = new MineflayerCropAccess(holderOf(bot))

    expect(access.stateAt(at)).toBeUndefined()
  })

  it('is undefined when there is no bot', () => {
    const access = new MineflayerCropAccess(holderOf(undefined))

    expect(access.stateAt(at)).toBeUndefined()
  })

  it('parses age when the server reports it as a numeric string, not a number', () => {
    // Real Mineflayer reports this blockstate property as a string ("7"); FakeBot's own getProperties()
    // gives a real number, so this exercises the string branch with a minimal stub block directly.
    const bot = {
      blockAt: () => ({ name: 'wheat', getProperties: () => ({ age: '7' }) }),
    } as unknown as BotLike
    const access = new MineflayerCropAccess(holderOf(bot))

    expect(access.stateAt(at)).toEqual({ name: 'wheat', age: 7 })
  })

  it('is undefined when the age property is not a parseable number', () => {
    const bot = {
      blockAt: () => ({ name: 'wheat', getProperties: () => ({ age: 'not-a-number' }) }),
    } as unknown as BotLike
    const access = new MineflayerCropAccess(holderOf(bot))

    expect(access.stateAt(at)).toBeUndefined()
  })
})
