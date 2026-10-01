import { describe, expect, it } from '@jest/globals'
import { MineflayerItemFacts } from '../../../../src/bot/mineflayer-item-facts.js'
import {
  ITEM_GROUP_NAMES,
  isGroup,
  isReserved,
  matchesAny,
  matchesSpec,
  unknownSpecs,
} from '../../../../src/skills/storage/item-matcher.js'
import { FakeBot } from '../../../fakes/fake-bot.js'

const facts = new MineflayerItemFacts({
  current: () => new FakeBot().useGameData(),
  onChange: () => () => undefined,
})

describe('item matching', () => {
  it('matches an exact item name', () => {
    expect(matchesSpec('cobblestone', 'cobblestone', facts)).toBe(true)
    expect(matchesSpec('cobblestone', 'stone', facts)).toBe(false)
  })

  it.each([
    ['logs', 'oak_log', true],
    ['logs', 'crimson_stem', true],
    ['logs', 'stripped_oak_log', false],
    ['logs', 'oak_planks', false],
    ['planks', 'birch_planks', true],
    ['wood', 'oak_log', true],
    ['wood', 'acacia_planks', true],
    ['stone', 'cobblestone', true],
    ['stone', 'diorite', true],
    ['stone', 'sand', false],
    ['ores', 'iron_ore', true],
    ['ores', 'deepslate_gold_ore', true],
    ['ores', 'raw_iron', true],
    ['ores', 'coal', true],
    ['ores', 'diamond', true],
    ['ores', 'iron_ingot', false],
    ['ingots', 'iron_ingot', true],
    ['ingots', 'gold_nugget', true],
    ['ingots', 'raw_iron', false],
    ['food', 'cooked_beef', true],
    ['food', 'bread', true],
    ['food', 'stick', false],
    ['tools', 'iron_pickaxe', true],
    ['tools', 'shears', true],
    ['tools', 'iron_helmet', false],
    ['armor', 'iron_helmet', true],
    ['armor', 'shield', true],
    ['blocks', 'dirt', true],
    ['blocks', 'cobblestone', true],
    ['blocks', 'stick', false],
    ['blocks', 'iron_pickaxe', false],
    ['wool', 'red_wool', true],
    ['dyes', 'blue_dye', true],
    ['*', 'anything', true],
  ])('group %s on %s is %s', (group, item, expected) => {
    expect(matchesSpec(group, item, facts)).toBe(expected)
  })

  it('matches any of several specs', () => {
    expect(matchesAny(['dirt', 'ores'], 'raw_iron', facts)).toBe(true)
    expect(matchesAny(['dirt', 'ores'], 'sand', facts)).toBe(false)
    expect(matchesAny([], 'sand', facts)).toBe(false)
  })

  it('knows the group names and tells groups from items', () => {
    expect(ITEM_GROUP_NAMES).toEqual(expect.arrayContaining(['logs', 'ores', 'food', '*']))
    expect(isGroup('ores')).toBe(true)
    expect(isGroup('dirt')).toBe(false)
  })

  it('finds specs that are neither a group nor an item', () => {
    expect(unknownSpecs(['ores', 'dirt', 'dirtt', 'oak_lgo'], facts)).toEqual(['dirtt', 'oak_lgo'])
  })
})

describe('reserved items', () => {
  it.each([
    'iron_pickaxe',
    'diamond_sword',
    'iron_helmet',
    'shield',
    'cooked_beef',
    'bread',
    'torch',
    'soul_torch',
    'water_bucket',
    'bow',
    'shears',
  ])('keeps %s', (item) => {
    expect(isReserved(item, facts)).toBe(true)
  })

  it.each(['cobblestone', 'oak_log', 'raw_iron', 'iron_ingot', 'stick', 'leather', 'coal', 'dirt'])(
    'may deposit %s',
    (item) => {
      expect(isReserved(item, facts)).toBe(false)
    },
  )
})

describe('MineflayerItemFacts', () => {
  it('reads items, food, blocks, and stack sizes from the game data', () => {
    expect(facts.isItem('cobblestone')).toBe(true)
    expect(facts.isItem('cobblestonee')).toBe(false)
    expect(facts.isFood('bread')).toBe(true)
    expect(facts.isFood('dirt')).toBe(false)
    expect(facts.isBlock('dirt')).toBe(true)
    expect(facts.isBlock('stick')).toBe(false)
    expect(facts.stackSize('dirt')).toBe(64)
    expect(facts.stackSize('ender_pearl')).toBe(16)
    expect(facts.stackSize('iron_pickaxe')).toBe(1)
  })

  it('knows nothing without a bot, and defaults the stack size', () => {
    const none = new MineflayerItemFacts({
      current: () => undefined,
      onChange: () => () => undefined,
    })

    expect(none.isItem('dirt')).toBe(false)
    expect(none.isFood('bread')).toBe(false)
    expect(none.isBlock('dirt')).toBe(false)
    expect(none.stackSize('dirt')).toBe(64)
  })
})
