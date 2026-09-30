import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerBlockUser } from '../../../src/bot/mineflayer-block-user.js'
import { MineflayerComposterAccess } from '../../../src/bot/mineflayer-composter.js'
import { FakeBot } from '../../fakes/fake-bot.js'

const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})
const at = { x: 3, y: 64, z: 5 }

describe('MineflayerBlockUser', () => {
  it('holds the item and right-clicks the block', async () => {
    const bot = new FakeBot().useGameData()
    bot.setBlock(at, 'wheat')
    bot.addItems('bone_meal', 2)
    const user = new MineflayerBlockUser(holderOf(bot))

    const result = await user.use(at, 'bone_meal')

    expect(result).toEqual({ ok: true, value: undefined })
    expect(bot.activateBlockCalls).toEqual([at])
    expect(bot.count('bone_meal')).toBe(1)
  })

  it('clicks with whatever is in hand when no item is given', async () => {
    const bot = new FakeBot().useGameData()
    bot.setBlock(at, 'composter')
    const user = new MineflayerBlockUser(holderOf(bot))

    expect(await user.use(at, undefined)).toEqual({ ok: true, value: undefined })
    expect(bot.activateBlockCalls).toEqual([at])
  })

  it('fails without the item, an unknown item, a loaded block, or a connection', async () => {
    const bot = new FakeBot().useGameData()
    bot.setBlock(at, 'wheat')
    const user = new MineflayerBlockUser(holderOf(bot))
    expect(await user.use(at, 'bone_meal')).toMatchObject({ ok: false })
    expect(await user.use(at, 'not_an_item')).toMatchObject({ ok: false })
    expect(await user.use({ x: 99, y: 64, z: 99 }, undefined)).toMatchObject({ ok: false })
    expect(await new MineflayerBlockUser(holderOf(undefined)).use(at, undefined)).toMatchObject({
      ok: false,
    })
  })
})

describe('MineflayerComposterAccess', () => {
  it('reads the level of a composter and nothing for other blocks', () => {
    const bot = new FakeBot()
    const access = new MineflayerComposterAccess(holderOf(bot))
    bot.setBlock(at, 'composter')
    expect(access.levelAt(at)).toBe(0)
    bot.setComposterLevel(at, 5)
    expect(access.levelAt(at)).toBe(5)
    bot.setBlock({ x: 0, y: 64, z: 0 }, 'stone')
    expect(access.levelAt({ x: 0, y: 64, z: 0 })).toBeUndefined()
    expect(access.levelAt({ x: 9, y: 64, z: 9 })).toBeUndefined()
    expect(new MineflayerComposterAccess(holderOf(undefined)).levelAt(at)).toBeUndefined()
  })
})
