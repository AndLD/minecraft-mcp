import { describe, expect, it } from '@jest/globals'
import { BlockFinder } from '../../../src/perception/block-finder.js'
import { isNotableBlock } from '../../../src/perception/notable-blocks.js'
import { SurroundingsDescriber } from '../../../src/perception/surroundings.js'
import { FakeBlockScanner, FakeEntityScanner, FakeVitals } from '../../fakes/fake-ports.js'

describe('isNotableBlock', () => {
  it.each([
    'iron_ore',
    'deepslate_diamond_ore',
    'ancient_debris',
    'oak_log',
    'crafting_table',
    'furnace',
    'chest',
    'trapped_chest',
    'ender_chest',
    'barrel',
    'red_bed',
    'water',
    'lava',
    'spawner',
    'obsidian',
  ])('%s is notable', (name) => {
    expect(isNotableBlock(name)).toBe(true)
  })

  it.each([
    'stone',
    'dirt',
    'grass_block',
    'oak_planks',
    'oak_leaves',
    'sand',
    'gravel',
    'chest_minecart',
  ])('%s is not notable', (name) => {
    expect(isNotableBlock(name)).toBe(false)
  })
})

describe('BlockFinder', () => {
  it('finds blocks for known names', () => {
    const scanner = new FakeBlockScanner()
    scanner.blocks = [{ name: 'oak_log', position: { x: 1, y: 64, z: 1 }, distance: 3 }]

    const result = new BlockFinder(scanner).find({ names: ['oak_log'], maxDistance: 32, count: 5 })

    expect(result).toEqual({ ok: true, value: scanner.blocks })
    expect(scanner.queries).toEqual([{ names: ['oak_log'], maxDistance: 32, count: 5 }])
  })

  it('returns an empty list when nothing is nearby', () => {
    const result = new BlockFinder(new FakeBlockScanner()).find({
      names: ['iron_ore'],
      maxDistance: 32,
      count: 5,
    })

    expect(result).toEqual({ ok: true, value: [] })
  })

  it('fails when not connected (no block names known)', () => {
    const scanner = new FakeBlockScanner()
    scanner.names = []

    expect(new BlockFinder(scanner).find({ names: ['stone'], maxDistance: 1, count: 1 })).toEqual({
      ok: false,
      error: 'Not connected to a Minecraft world.',
    })
  })

  it('suggests similar names for an unknown one', () => {
    const scanner = new FakeBlockScanner()
    scanner.names = ['oak_log', 'birch_log', 'stone']

    const result = new BlockFinder(scanner).find({ names: ['log'], maxDistance: 32, count: 5 })

    expect(result).toEqual({
      ok: false,
      error: '"log" is not a block name; did you mean: oak_log, birch_log?',
    })
  })

  it('says so plainly when nothing is similar', () => {
    const result = new BlockFinder(new FakeBlockScanner()).find({
      names: ['zzz'],
      maxDistance: 32,
      count: 5,
    })

    expect(result).toEqual({ ok: false, error: '"zzz" is not a block name' })
  })

  it('reports every unknown name', () => {
    const result = new BlockFinder(new FakeBlockScanner()).find({
      names: ['aaa', 'bbb'],
      maxDistance: 32,
      count: 5,
    })

    expect(!result.ok && result.error).toBe('"aaa" is not a block name. "bbb" is not a block name')
  })
})

describe('SurroundingsDescriber', () => {
  function setup() {
    const blocks = new FakeBlockScanner()
    const entities = new FakeEntityScanner()
    const vitals = new FakeVitals()
    vitals.vitals = {
      health: 20,
      food: 20,
      position: { x: 10.26, y: 64, z: -3.5 },
      dimension: 'overworld',
      timeOfDay: 6000,
    }
    return {
      blocks,
      entities,
      vitals,
      describer: new SurroundingsDescriber(blocks, entities, vitals),
    }
  }

  it('fails when not connected', () => {
    const { describer, vitals } = setup()
    vitals.vitals = undefined

    expect(describer.describe(8)).toEqual({
      ok: false,
      error: 'Not connected to a Minecraft world.',
    })
  })

  it('describes position, dimension, time, and the block underfoot', () => {
    const { describer, blocks } = setup()
    blocks.blockNames.set('10,63,-4', 'grass_block')

    const result = describer.describe(8)

    expect(result).toMatchObject({
      ok: true,
      value: {
        position: { x: 10.3, y: 64, z: -3.5 },
        dimension: 'overworld',
        timeOfDay: 6000,
        standingOn: 'grass_block',
        radius: 8,
      },
    })
  })

  it('reports null when the block underfoot is not loaded', () => {
    const result = setup().describer.describe(8)

    expect(result.ok && result.value.standingOn).toBeNull()
  })

  it('separates notable blocks (nearest first) from common terrain (most common first)', () => {
    const { describer, blocks } = setup()
    blocks.summaries = [
      { name: 'stone', count: 200, nearest: { x: 0, y: 0, z: 0 }, nearestDistance: 1 },
      { name: 'dirt', count: 300, nearest: { x: 0, y: 0, z: 0 }, nearestDistance: 1 },
      { name: 'iron_ore', count: 4, nearest: { x: 1, y: 2, z: 3 }, nearestDistance: 6.04 },
      { name: 'oak_log', count: 30, nearest: { x: 4, y: 5, z: 6 }, nearestDistance: 2.26 },
    ]

    const result = describer.describe(8)

    expect(result.ok && result.value.notableBlocks).toEqual([
      { name: 'oak_log', count: 30, nearest: { x: 4, y: 5, z: 6 }, distance: 2.3 },
      { name: 'iron_ore', count: 4, nearest: { x: 1, y: 2, z: 3 }, distance: 6 },
    ])
    expect(result.ok && result.value.terrain).toEqual([
      { name: 'dirt', count: 300 },
      { name: 'stone', count: 200 },
    ])
  })

  it('limits the notable blocks and terrain lists', () => {
    const { describer, blocks } = setup()
    blocks.summaries = [
      ...Array.from({ length: 20 }, (_, i) => ({
        name: `x${String(i)}_ore`,
        count: 1,
        nearest: { x: 0, y: 0, z: 0 },
        nearestDistance: i,
      })),
      ...Array.from({ length: 9 }, (_, i) => ({
        name: `terrain${String(i)}`,
        count: i,
        nearest: { x: 0, y: 0, z: 0 },
        nearestDistance: 1,
      })),
    ]

    const result = describer.describe(8)

    expect(result.ok && result.value.notableBlocks).toHaveLength(15)
    expect(result.ok && result.value.terrain).toHaveLength(5)
  })

  it('groups nearby entities by kind with counts and the nearest distance', () => {
    const { describer, entities } = setup()
    const at = { x: 0, y: 0, z: 0 }
    entities.entities = [
      { id: 1, category: 'hostile', name: 'zombie', position: at, distance: 3.04 },
      { id: 2, category: 'hostile', name: 'zombie', position: at, distance: 5 },
      { id: 3, category: 'animal', name: 'cow', position: at, distance: 7 },
      { id: 4, category: 'player', name: 'Andrey_Knight', position: at, distance: 9 },
      { id: 5, category: 'hostile', name: 'zombie', position: at, distance: 40 },
    ]

    const result = describer.describe(8)

    expect(result.ok && result.value.entities).toEqual([
      { name: 'zombie', category: 'hostile', count: 2, nearestDistance: 3 },
      { name: 'cow', category: 'animal', count: 1, nearestDistance: 7 },
      { name: 'Andrey_Knight', category: 'player', count: 1, nearestDistance: 9 },
    ])
  })
})
