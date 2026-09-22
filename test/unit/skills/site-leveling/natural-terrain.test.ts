import { describe, expect, it } from '@jest/globals'
import {
  isClearable,
  isNaturalTerrain,
  isTreePart,
  isVegetation,
  pickFillBlock,
} from '../../../../src/skills/site-leveling/natural-terrain.js'

describe('isNaturalTerrain', () => {
  it('accepts plain stone and soil, and ore', () => {
    for (const name of [
      'dirt',
      'stone',
      'sand',
      'gravel',
      'grass_block',
      'iron_ore',
      'deepslate_diamond_ore',
    ])
      expect(isNaturalTerrain(name)).toBe(true)
  })

  it('rejects anything a player made', () => {
    for (const name of ['oak_planks', 'oak_fence', 'chest', 'oak_door', 'glass', 'torch'])
      expect(isNaturalTerrain(name)).toBe(false)
  })
})

describe('isVegetation', () => {
  it('accepts grass, flowers, saplings, and dead growth', () => {
    for (const name of ['short_grass', 'dandelion', 'oak_sapling', 'dead_bush', 'vine'])
      expect(isVegetation(name)).toBe(true)
  })

  it('rejects logs, leaves, and player-made blocks', () => {
    for (const name of ['oak_log', 'oak_leaves', 'chest']) expect(isVegetation(name)).toBe(false)
  })
})

describe('isTreePart', () => {
  it('accepts logs and leaves, stripped or not', () => {
    for (const name of ['oak_log', 'stripped_oak_log', 'birch_wood', 'oak_leaves', 'spruce_leaves'])
      expect(isTreePart(name)).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isTreePart('dirt')).toBe(false)
    expect(isTreePart('oak_planks')).toBe(false)
  })
})

describe('isClearable', () => {
  it('clears natural terrain and vegetation whether or not clear_trees is on', () => {
    expect(isClearable('dirt', false)).toBe(true)
    expect(isClearable('dirt', true)).toBe(true)
    expect(isClearable('short_grass', false)).toBe(true)
  })

  it('only clears a tree when clearTrees is true', () => {
    expect(isClearable('oak_log', false)).toBe(false)
    expect(isClearable('oak_log', true)).toBe(true)
    expect(isClearable('oak_leaves', false)).toBe(false)
    expect(isClearable('oak_leaves', true)).toBe(true)
  })

  it('never clears a player-made block, whatever clearTrees is', () => {
    expect(isClearable('chest', false)).toBe(false)
    expect(isClearable('chest', true)).toBe(false)
  })
})

describe('pickFillBlock', () => {
  it('picks the biggest pile of a real fill candidate', () => {
    expect(
      pickFillBlock([
        { name: 'stick', count: 40 }, // not a fill candidate, however big the pile
        { name: 'cobblestone', count: 20 },
        { name: 'dirt', count: 5 },
      ]),
    ).toBe('cobblestone')
  })

  it('falls back to dirt when nothing gained is a fill candidate', () => {
    expect(pickFillBlock([{ name: 'stick', count: 3 }])).toBe('dirt')
    expect(pickFillBlock([])).toBe('dirt')
  })
})
