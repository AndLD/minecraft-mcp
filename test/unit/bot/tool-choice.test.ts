import { describe, expect, it } from '@jest/globals'
import { chooseTool, preferredKind } from '../../../src/bot/tool-choice.js'

describe('preferredKind', () => {
  it.each([
    ['mineable/pickaxe', 'pickaxe'],
    ['mineable/axe', 'axe'],
    ['mineable/shovel', 'shovel'],
    ['leaves;mineable/hoe', 'hoe'],
    ['plant;mineable/axe', 'axe'],
  ])('reads %s as %s', (material, kind) => {
    expect(preferredKind(material)).toBe(kind)
  })

  it('has no preference for other or missing materials', () => {
    expect(preferredKind('default')).toBeUndefined()
    expect(preferredKind('mineable/unknown')).toBeUndefined()
    expect(preferredKind(undefined)).toBeUndefined()
  })
})

describe('chooseTool', () => {
  it('needs no tool for a block that drops with anything', () => {
    expect(chooseTool({ harvestTools: [], material: 'default', carried: ['dirt'] })).toEqual({
      canHarvest: true,
      tool: undefined,
    })
  })

  it('takes the best tool of the right kind for a block that needs none', () => {
    const choice = chooseTool({
      harvestTools: [],
      material: 'mineable/axe',
      carried: ['wooden_axe', 'iron_axe', 'diamond_pickaxe', 'stone_axe'],
    })

    expect(choice).toEqual({ canHarvest: true, tool: 'iron_axe' })
  })

  it('digs by hand when no tool of the right kind is carried', () => {
    const choice = chooseTool({
      harvestTools: [],
      material: 'mineable/axe',
      carried: ['diamond_pickaxe'],
    })

    expect(choice).toEqual({ canHarvest: true, tool: undefined })
  })

  it('cannot harvest a block that needs a tool the bot does not carry', () => {
    const choice = chooseTool({
      harvestTools: ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'],
      material: 'mineable/pickaxe',
      carried: ['wooden_pickaxe', 'iron_axe'],
    })

    expect(choice).toEqual({ canHarvest: false, tool: undefined })
  })

  it('takes the fastest tool that is good enough', () => {
    const choice = chooseTool({
      harvestTools: ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'],
      material: 'mineable/pickaxe',
      carried: ['stone_pickaxe', 'diamond_pickaxe', 'wooden_pickaxe'],
    })

    expect(choice).toEqual({ canHarvest: true, tool: 'diamond_pickaxe' })
  })

  it('ranks tiers netherite, diamond, iron, golden, stone, wooden', () => {
    const best = (carried: string[]) =>
      chooseTool({ harvestTools: [], material: 'mineable/pickaxe', carried }).tool

    expect(best(['wooden_pickaxe', 'stone_pickaxe'])).toBe('stone_pickaxe')
    expect(best(['stone_pickaxe', 'golden_pickaxe'])).toBe('golden_pickaxe')
    expect(best(['golden_pickaxe', 'iron_pickaxe'])).toBe('iron_pickaxe')
    expect(best(['iron_pickaxe', 'netherite_pickaxe', 'diamond_pickaxe'])).toBe('netherite_pickaxe')
  })
})

describe('chooseTool for leaves', () => {
  const leaves = { harvestTools: [], material: 'leaves;mineable/hoe' }

  it('never picks shears: they make a leaf drop itself and no sapling', () => {
    expect(chooseTool({ ...leaves, carried: ['shears'] })).toEqual({ canHarvest: true, tool: undefined })
    expect(chooseTool({ ...leaves, carried: ['shears', 'iron_hoe', 'wooden_hoe'] })).toEqual({
      canHarvest: true,
      tool: 'iron_hoe',
    })
  })
})
