import { describe, expect, it } from '@jest/globals'
import {
  isLeavesName,
  isLogName,
  isPassThrough,
  isPlantableGround,
  isSaplingName,
  isTreeAvoidedNeighbour,
  leavesOf,
  SAPLING_ITEMS,
  speciesOfBlocks,
  speciesOfLog,
  TREE_NAMES,
  treeFor,
} from '../../../../src/skills/farming/tree-table.js'

describe('tree table', () => {
  it('finds a species by name, sapling, or log', () => {
    expect(treeFor('oak')?.sapling).toBe('oak_sapling')
    expect(treeFor('birch_sapling')?.name).toBe('birch')
    expect(treeFor('dark_oak_log')?.name).toBe('dark_oak')
    expect(treeFor('mangrove')).toBeUndefined()
  })

  it('lists every species it can plant', () => {
    expect(TREE_NAMES).toEqual(['oak', 'birch', 'spruce', 'jungle', 'acacia', 'dark_oak', 'cherry'])
  })

  it('knows which species grow big and which only grow big', () => {
    expect(treeFor('oak')).toMatchObject({ canBig: false, forceBig: false })
    expect(treeFor('spruce')).toMatchObject({ canBig: true, forceBig: false })
    expect(treeFor('jungle')).toMatchObject({ canBig: true, forceBig: false })
    expect(treeFor('dark_oak')).toMatchObject({ canBig: true, forceBig: true })
    expect(treeFor('spruce')?.bigSpacing).toBeGreaterThan(treeFor('spruce')?.spacing ?? 0)
  })

  it('names the species of a log', () => {
    expect(speciesOfLog('spruce_log')?.name).toBe('spruce')
    expect(speciesOfLog('mangrove_log')).toBeUndefined()
  })

  it('classifies logs (never stripped ones), saplings, leaves', () => {
    expect(isLogName('oak_log')).toBe(true)
    expect(isLogName('stripped_oak_log')).toBe(false)
    expect(isLogName('oak_planks')).toBe(false)
    expect(isSaplingName('birch_sapling')).toBe(true)
    expect(isLeavesName('oak_leaves')).toBe(true)
  })

  it('knows what a sapling stands on, and what a tree grows through', () => {
    expect(isPlantableGround('grass_block')).toBe(true)
    expect(isPlantableGround('podzol')).toBe(true)
    expect(isPlantableGround('stone')).toBe(false)
    expect(isPassThrough('air')).toBe(true)
    expect(isPassThrough('short_grass')).toBe(true)
    expect(isPassThrough('oak_log')).toBe(false)
  })

  it('names the neighbours a tree keeps clear of', () => {
    for (const name of ['dirt_path', 'farmland', 'oak_door', 'birch_fence_gate', 'oak_trapdoor'])
      expect(isTreeAvoidedNeighbour(name)).toBe(true)
    expect(isTreeAvoidedNeighbour('stone')).toBe(false)
  })

  it('names the leaves and every sapling', () => {
    const darkOak = treeFor('dark_oak')
    if (darkOak === undefined) throw new Error('missing species')
    expect(leavesOf(darkOak)).toBe('dark_oak_leaves')
    expect(SAPLING_ITEMS).toContain('cherry_sapling')
    expect(SAPLING_ITEMS).toHaveLength(TREE_NAMES.length)
  })

  it('reads the one species a set of blocks is about, or none', () => {
    expect(speciesOfBlocks(['oak_log'])?.name).toBe('oak')
    expect(speciesOfBlocks(['oak_log', 'oak_log'])?.name).toBe('oak')
    expect(speciesOfBlocks(['oak_log', 'birch_log'])).toBeUndefined()
    expect(speciesOfBlocks(['logs'])).toBeUndefined()
    expect(speciesOfBlocks(['oak_log', 'stone'])).toBeUndefined()
    expect(speciesOfBlocks([])).toBeUndefined()
  })
})
