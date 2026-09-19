import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerGaze } from '../../../src/bot/mineflayer-gaze.js'
import { MineflayerInventoryWriter } from '../../../src/bot/mineflayer-inventory-writer.js'
import { MineflayerItemFacts } from '../../../src/bot/mineflayer-item-facts.js'
import { FakeBot } from '../../fakes/fake-bot.js'

const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})

describe('MineflayerInventoryWriter', () => {
  it('throws items out in front of the bot, and takes them out of the inventory', async () => {
    const bot = new FakeBot().useGameData()
    bot.inventoryItems = [
      { name: 'cobblestone', count: 150 },
      { name: 'stick', count: 4 },
    ]

    const thrown = await new MineflayerInventoryWriter(holderOf(bot)).toss('cobblestone', 100)

    expect(thrown).toBe(100)
    expect(bot.count('cobblestone')).toBe(50)
    expect(bot.count('stick')).toBe(4)
    expect(bot.tossed.reduce((sum, t) => sum + t.count, 0)).toBe(100)
    expect(Object.values(bot.entities).filter((e) => e.name === 'item')).toHaveLength(
      bot.tossed.length,
    )
  })

  it('throws nothing without a bot', async () => {
    expect(await new MineflayerInventoryWriter(holderOf(undefined)).toss('dirt', 5)).toBe(0)
  })
})

describe('MineflayerGaze', () => {
  it('turns the bot to face a point', async () => {
    const bot = new FakeBot()

    await new MineflayerGaze(holderOf(bot)).lookAt({ x: 3, y: 65, z: -2 })

    expect(bot.lookedAt).toEqual([expect.objectContaining({ x: 3, y: 65, z: -2 })])
    expect(bot.waitedTicks).toBeGreaterThan(0) // the server needs a moment to learn where the bot looks
  })

  it('does nothing without a bot', async () => {
    await expect(
      new MineflayerGaze(holderOf(undefined)).lookAt({ x: 0, y: 0, z: 0 }),
    ).resolves.toBeUndefined()
  })
})

describe('MineflayerItemFacts.allItems', () => {
  it('lists every item name the game knows', () => {
    const facts = new MineflayerItemFacts(holderOf(new FakeBot().useGameData()))

    expect(facts.allItems()).toEqual(expect.arrayContaining(['iron_ingot', 'cobblestone', 'stick']))
    expect(new MineflayerItemFacts(holderOf(undefined)).allItems()).toEqual([])
  })
})
