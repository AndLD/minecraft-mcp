import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerRailAccess } from '../../../src/bot/mineflayer-rail-access.js'
import { FakeBot } from '../../fakes/fake-bot.js'

const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})

const at = (x: number, z = 0) => ({ x, y: 64, z })

describe('MineflayerRailAccess', () => {
  it('reads a rail’s kind and the shape its neighbours give it', () => {
    const bot = new FakeBot()
    for (const x of [0, 1, 2]) bot.setBlock(at(x), 'rail')
    bot.setBlock(at(2, 1), 'rail')
    const rails = new MineflayerRailAccess(holderOf(bot))

    expect(rails.stateAt(at(1))).toEqual({ name: 'rail', shape: 'east_west', powered: undefined })
    expect(rails.stateAt(at(2))).toEqual({ name: 'rail', shape: 'south_west', powered: undefined })
  })

  it('reads a slope, and whether a powered rail is powered', () => {
    const bot = new FakeBot()
    bot.setBlock(at(0), 'powered_rail')
    bot.setBlock({ x: 1, y: 65, z: 0 }, 'rail')
    bot.setBlock(at(0, -1), 'redstone_torch')
    const rails = new MineflayerRailAccess(holderOf(bot))

    expect(rails.stateAt(at(0))).toEqual({ name: 'powered_rail', shape: 'ascending_east', powered: true })
    bot.setBlock(at(0, -1), 'air')
    expect(rails.stateAt(at(0))?.powered).toBe(false)
  })

  it('reads a boolean power property as well as the string the server sends', () => {
    const bot = new FakeBot()
    bot.setBlock(at(0), 'powered_rail')
    const block = bot.blockAt({ ...at(0), floored: () => at(0) } as never)
    if (block === null) throw new Error('no block')
    block.getProperties = () => ({ shape: 'east_west', powered: true })
    bot.blockAt = () => block
    const rails = new MineflayerRailAccess(holderOf(bot))

    expect(rails.stateAt(at(0))?.powered).toBe(true)
  })

  it('has nothing for a block that is not a rail, is not loaded, or when not connected', () => {
    const bot = new FakeBot()
    bot.setBlock(at(0), 'stone')

    expect(new MineflayerRailAccess(holderOf(bot)).stateAt(at(0))).toBeUndefined()
    expect(new MineflayerRailAccess(holderOf(bot)).stateAt(at(9))).toBeUndefined()
    expect(new MineflayerRailAccess(holderOf(undefined)).stateAt(at(0))).toBeUndefined()
  })

  it('tolerates a block with no properties', () => {
    const bot = new FakeBot()
    bot.setBlock(at(0), 'rail')
    const block = bot.blockAt({ ...at(0), floored: () => at(0) } as never)
    if (block === null) throw new Error('no block')
    bot.blockAt = () => ({ ...block, getProperties: undefined })

    expect(new MineflayerRailAccess(holderOf(bot)).stateAt(at(0))).toEqual({
      name: 'rail',
      shape: undefined,
      powered: undefined,
    })
  })
})
