import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerBlockScanner } from '../../../src/bot/mineflayer-block-scanner.js'
import { MineflayerEntityScanner } from '../../../src/bot/mineflayer-entity-scanner.js'
import { MineflayerInventory } from '../../../src/bot/mineflayer-inventory.js'
import { FakeBot } from '../../fakes/fake-bot.js'

const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})

function botAtOrigin(): FakeBot {
  const bot = new FakeBot()
  bot.entity = { position: { x: 0.5, y: 64, z: 0.5 } }
  return bot
}

describe('MineflayerBlockScanner', () => {
  it('knows nothing without a bot', () => {
    const scanner = new MineflayerBlockScanner(holderOf(undefined))

    expect(scanner.knownBlockNames()).toEqual([])
    expect(scanner.findBlocks({ names: ['stone'], maxDistance: 10, count: 5 })).toEqual([])
    expect(scanner.blockAt({ x: 0, y: 0, z: 0 })).toBeUndefined()
    expect(scanner.sampleBlocks(3)).toEqual([])
  })

  it('lists the block names of the game version', () => {
    const scanner = new MineflayerBlockScanner(holderOf(botAtOrigin()))

    expect(scanner.knownBlockNames()).toEqual(
      expect.arrayContaining(['stone', 'oak_log', 'iron_ore']),
    )
  })

  it('finds blocks by name, nearest first, with names and distances', () => {
    const bot = botAtOrigin()
    bot.setBlock({ x: 5, y: 64, z: 0 }, 'oak_log')
    bot.setBlock({ x: 2, y: 64, z: 0 }, 'oak_log')
    bot.setBlock({ x: 3, y: 64, z: 0 }, 'stone')
    const scanner = new MineflayerBlockScanner(holderOf(bot))

    const found = scanner.findBlocks({ names: ['oak_log'], maxDistance: 20, count: 5 })

    expect(found.map((b) => b.position)).toEqual([
      { x: 2, y: 64, z: 0 },
      { x: 5, y: 64, z: 0 },
    ])
    expect(found.map((b) => b.name)).toEqual(['oak_log', 'oak_log'])
    expect(found[0]?.distance).toBeCloseTo(Math.hypot(1.5, 0.5))
  })

  it('respects the distance and count limits', () => {
    const bot = botAtOrigin()
    for (let x = 1; x <= 5; x += 1) bot.setBlock({ x, y: 64, z: 0 }, 'stone')
    const scanner = new MineflayerBlockScanner(holderOf(bot))

    expect(scanner.findBlocks({ names: ['stone'], maxDistance: 20, count: 2 })).toHaveLength(2)
    expect(scanner.findBlocks({ names: ['stone'], maxDistance: 2, count: 10 })).toHaveLength(2)
  })

  it('finds nothing for unknown names', () => {
    const scanner = new MineflayerBlockScanner(holderOf(botAtOrigin()))

    expect(scanner.findBlocks({ names: ['not_a_block'], maxDistance: 10, count: 5 })).toEqual([])
  })

  it('skips positions whose block cannot be read', () => {
    const bot = botAtOrigin()
    bot.setBlock({ x: 2, y: 64, z: 0 }, 'stone')
    bot.blockAt = () => null
    const scanner = new MineflayerBlockScanner(holderOf(bot))

    expect(scanner.findBlocks({ names: ['stone'], maxDistance: 10, count: 5 })).toEqual([])
  })

  it('reads the block at a position', () => {
    const bot = botAtOrigin()
    bot.setBlock({ x: 1, y: 63, z: 1 }, 'dirt')
    const scanner = new MineflayerBlockScanner(holderOf(bot))

    expect(scanner.blockAt({ x: 1, y: 63, z: 1 })).toBe('dirt')
    expect(scanner.blockAt({ x: 9, y: 9, z: 9 })).toBeUndefined()
  })

  it('summarizes the blocks around the bot, ignoring air and unloaded space', () => {
    const bot = botAtOrigin()
    bot.setBlock({ x: 0, y: 63, z: 0 }, 'stone')
    bot.setBlock({ x: 1, y: 63, z: 0 }, 'stone')
    bot.setBlock({ x: 3, y: 63, z: 3 }, 'stone')
    bot.setBlock({ x: 0, y: 64, z: 2 }, 'iron_ore')
    bot.setBlock({ x: 0, y: 65, z: 0 }, 'air')
    bot.setBlock({ x: 1, y: 65, z: 0 }, 'cave_air')
    const scanner = new MineflayerBlockScanner(holderOf(bot))

    const summary = scanner.sampleBlocks(4)

    const stone = summary.find((s) => s.name === 'stone')
    expect(stone).toMatchObject({ count: 3, nearest: { x: 0, y: 63, z: 0 } })
    expect(summary.find((s) => s.name === 'iron_ore')).toMatchObject({
      count: 1,
      nearest: { x: 0, y: 64, z: 2 },
    })
    expect(summary.map((s) => s.name).sort()).toEqual(['iron_ore', 'stone'])
  })
})

describe('MineflayerEntityScanner', () => {
  function botWithEntities(): FakeBot {
    const bot = botAtOrigin()
    bot.entities['1'] = {
      id: 1,
      type: 'player',
      username: 'ClaudeBot',
      position: { x: 0.5, y: 64, z: 0.5 },
    }
    bot.entities['2'] = {
      id: 2,
      type: 'hostile',
      name: 'zombie',
      position: { x: 4.5, y: 64, z: 0.5 },
    }
    bot.entities['3'] = { id: 3, type: 'animal', name: 'cow', position: { x: 2.5, y: 64, z: 0.5 } }
    bot.entities['4'] = {
      id: 4,
      type: 'player',
      username: 'Andrey_Knight',
      position: { x: 30.5, y: 64, z: 0.5 },
    }
    bot.entities['5'] = { id: 5, type: 'orb', position: { x: 1.5, y: 64, z: 0.5 } }
    bot.players['Andrey_Knight'] = { username: 'Andrey_Knight', entity: bot.entities['4'] }
    bot.players['Far_Away'] = { username: 'Far_Away' }
    return bot
  }

  it('sees nothing without a bot', () => {
    const scanner = new MineflayerEntityScanner(holderOf(undefined))

    expect(scanner.nearby(10)).toEqual([])
    expect(scanner.player('A')).toBeUndefined()
  })

  it('lists nearby entities nearest first, without the bot itself, within the radius', () => {
    const scanner = new MineflayerEntityScanner(holderOf(botWithEntities()))

    const nearby = scanner.nearby(10)

    expect(nearby.map((e) => e.name)).toEqual(['orb', 'cow', 'zombie'])
    expect(nearby.map((e) => e.category)).toEqual(['orb', 'animal', 'hostile'])
    expect(nearby.map((e) => e.distance)).toEqual([1, 2, 4])
  })

  it('names players by their username', () => {
    const scanner = new MineflayerEntityScanner(holderOf(botWithEntities()))

    expect(scanner.nearby(50).find((e) => e.id === 4)?.name).toBe('Andrey_Knight')
  })

  it('finds a visible player with position and distance, ignoring case', () => {
    const scanner = new MineflayerEntityScanner(holderOf(botWithEntities()))

    expect(scanner.player('andrey_knight')).toEqual({
      name: 'Andrey_Knight',
      online: true,
      position: { x: 30.5, y: 64, z: 0.5 },
      distance: 30,
    })
  })

  it('reports an online player who is out of view without a position', () => {
    const scanner = new MineflayerEntityScanner(holderOf(botWithEntities()))

    expect(scanner.player('Far_Away')).toEqual({
      name: 'Far_Away',
      online: true,
      position: undefined,
      distance: undefined,
    })
  })

  it('does not know players who are not online', () => {
    expect(
      new MineflayerEntityScanner(holderOf(botWithEntities())).player('Nobody'),
    ).toBeUndefined()
  })

  it('cannot measure distances before the bot has a position', () => {
    const bot = botWithEntities()
    bot.entity = undefined
    const scanner = new MineflayerEntityScanner(holderOf(bot))

    expect(scanner.nearby(10)).toEqual([])
    expect(scanner.player('Andrey_Knight')?.distance).toBeUndefined()
  })
})

describe('MineflayerInventory', () => {
  it('reads nothing without a bot', () => {
    expect(new MineflayerInventory(holderOf(undefined)).snapshot()).toBeUndefined()
  })

  it('reads the stacks, free slots, and the item in hand', () => {
    const bot = new FakeBot()
    bot.inventoryItems = [
      { name: 'cobblestone', count: 64 },
      { name: 'cobblestone', count: 20 },
      { name: 'stick', count: 4 },
    ]
    bot.emptySlots = 33
    bot.heldItem = { name: 'stick', count: 4 }

    expect(new MineflayerInventory(holderOf(bot)).snapshot()).toEqual({
      stacks: [
        { name: 'cobblestone', count: 64 },
        { name: 'cobblestone', count: 20 },
        { name: 'stick', count: 4 },
      ],
      emptySlots: 33,
      heldItem: 'stick',
    })
  })

  it('reports no held item when the hand is empty', () => {
    expect(new MineflayerInventory(holderOf(new FakeBot())).snapshot()?.heldItem).toBeUndefined()
  })
})
