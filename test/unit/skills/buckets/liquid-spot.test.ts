import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { isPlayerBuilt } from '../../../../src/skills/buckets/bucket-table.js'
import { LiquidSpotFinder } from '../../../../src/skills/buckets/liquid-spot.js'
import { BucketWorld } from '../../../fakes/bucket-fakes.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })
const SURFACE = 63
const feet = (x: number, z: number): Position => at(x + 0.5, SURFACE + 1, z + 0.5)

describe('LiquidSpotFinder', () => {
  it('keeps the bot where it stands when that already works', () => {
    const world = new BucketWorld()
    world.setBlock(at(3, SURFACE, 0), 'water')
    const from = feet(1, 0)

    expect(
      new LiquidSpotFinder(world).find({ liquid: 'water', source: at(3, SURFACE, 0), from }),
    ).toBe(from)
  })

  it('finds a spot within reach and on solid ground for a source far away', () => {
    const world = new BucketWorld()
    world.setBlock(at(20, SURFACE, 0), 'water')

    const spot = new LiquidSpotFinder(world).find({
      liquid: 'water',
      source: at(20, SURFACE, 0),
      from: feet(0, 0),
    })

    expect(spot).toBeDefined()
    expect(Math.hypot((spot?.x ?? 0) - 20.5, (spot?.z ?? 0) - 0.5)).toBeLessThanOrEqual(4)
    expect(
      world.isSolid(at(Math.floor(spot?.x ?? 0), (spot?.y ?? 0) - 1, Math.floor(spot?.z ?? 0))),
    ).toBe(true)
  })

  it('may stand in shallow water but never with its head under it', () => {
    const world = new BucketWorld()
    // A pool two blocks deep over ground: the source sits in the middle at the bot's feet level.
    world.pool('water', at(5, SURFACE + 1, 0), at(9, SURFACE + 1, 4))
    world.pool('water', at(5, SURFACE + 2, 0), at(9, SURFACE + 2, 4))
    const finder = new LiquidSpotFinder(world)

    const spot = finder.find({ liquid: 'water', source: at(7, SURFACE + 1, 2), from: feet(7, 2) })

    expect(spot).toBeDefined()
    const cellOfSpot = at(
      Math.floor(spot?.x ?? 0),
      Math.floor(spot?.y ?? 0),
      Math.floor(spot?.z ?? 0),
    )
    expect(world.blockAt({ ...cellOfSpot, y: cellOfSpot.y + 1 })).not.toBe('water')
  })

  it('stands in flowing water when that is all there is within reach', () => {
    const world = new BucketWorld()
    world.setBlock(at(7, SURFACE + 1, 2), 'water')
    for (let x = 4; x <= 10; x += 1)
      for (let z = -1; z <= 5; z += 1)
        if (x !== 7 || z !== 2) world.flowing('water', at(x, SURFACE + 1, z), 2)

    const spot = new LiquidSpotFinder(world).find({
      liquid: 'water',
      source: at(7, SURFACE + 1, 2),
      from: feet(0, 0),
    })

    expect(spot).toBeDefined()
  })

  it('prefers dry ground to a wet spot when both are in reach', () => {
    const world = new BucketWorld()
    world.setBlock(at(10, SURFACE, 0), 'water')
    world.setBlock(at(8, SURFACE + 1, 0), 'water') // a puddle at feet level right beside the bot's way in
    const spot = new LiquidSpotFinder(world).find({
      liquid: 'water',
      source: at(10, SURFACE, 0),
      from: feet(-3, 0),
    })

    expect(spot).toBeDefined()
    expect(world.blockAt(spot ?? at(0, 0, 0))).not.toBe('water')
  })

  it('finds nothing when a wall blocks the line to the source from every spot in reach', () => {
    const world = new BucketWorld()
    world.setBlock(at(6, SURFACE, 0), 'water')
    // The source sits in a solid stone shell: a ring around it and a two-block cap over it.
    for (let x = 5; x <= 7; x += 1)
      for (let z = -1; z <= 1; z += 1) {
        world.setBlock(at(x, SURFACE + 1, z), 'stone')
        if (x !== 6 || z !== 0) world.setBlock(at(x, SURFACE, z), 'stone')
      }

    expect(
      new LiquidSpotFinder(world).find({
        liquid: 'water',
        source: at(6, SURFACE, 0),
        from: feet(0, 0),
      }),
    ).toBeUndefined()
  })

  it('finds nothing when the ground near the source is not loaded', () => {
    const world = new BucketWorld()
    world.setBlock(at(6, SURFACE, 0), 'water')
    for (let x = 0; x <= 12; x += 1)
      for (let z = -6; z <= 6; z += 1)
        for (let y = SURFACE - 1; y <= SURFACE + 3; y += 1)
          world.unloaded.add(`${String(x)},${String(y)},${String(z)}`)

    expect(
      new LiquidSpotFinder(world).find({
        liquid: 'water',
        source: at(6, SURFACE, 0),
        from: feet(-3, 0),
      }),
    ).toBeUndefined()
  })

  describe('for lava', () => {
    it('does not stand within one block of lava, even diagonally below its feet', () => {
      const world = new BucketWorld()
      world.setBlock(at(6, SURFACE, 0), 'lava')
      const finder = new LiquidSpotFinder(world)

      const spot = finder.find({ liquid: 'lava', source: at(6, SURFACE, 0), from: feet(5, 0) })

      expect(spot).toBeDefined()
      expect(finder.lavaSafe(spot ?? at(0, 0, 0))).toBe(true)
      expect(Math.abs((spot?.x ?? 0) - 6.5) >= 2 || Math.abs((spot?.z ?? 0) - 0.5) >= 2).toBe(true)
    })

    it('lavaSafe is false with lava beside, below-beside, or above, and true with lava only two away', () => {
      const world = new BucketWorld()
      const finder = new LiquidSpotFinder(world)
      const here = at(10.5, SURFACE + 1, 10.5)
      expect(finder.lavaSafe(here)).toBe(true)

      world.setBlock(at(12, SURFACE + 1, 10), 'lava')
      expect(finder.lavaSafe(here)).toBe(true)

      for (const cell of [at(11, SURFACE + 1, 10), at(11, SURFACE, 11), at(10, SURFACE + 4, 10)]) {
        const flooded = new BucketWorld()
        flooded.setBlock(cell, 'lava')
        expect(new LiquidSpotFinder(flooded).lavaSafe(here)).toBe(false)
      }
    })

    it('lavaSafe is false when the surroundings are not loaded', () => {
      const world = new BucketWorld()
      world.unloaded.add('11,64,10')

      expect(new LiquidSpotFinder(world).lavaSafe(at(10.5, SURFACE + 1, 10.5))).toBe(false)
    })

    it('never takes lava from below: a source above the head is out', () => {
      const world = new BucketWorld()
      world.setBlock(at(6, SURFACE + 4, 0), 'lava')
      // A platform under it, so there is ground within reach that is not right under the lava.
      for (let x = 3; x <= 9; x += 1)
        for (let z = -3; z <= 3; z += 1) world.setBlock(at(x, SURFACE + 3, z), 'stone')

      const spot = new LiquidSpotFinder(world).find({
        liquid: 'lava',
        source: at(6, SURFACE + 4, 0),
        from: feet(0, 0),
      })

      // Standing on the platform puts the source at the bot's feet: from the side, not from below.
      expect(spot).toBeDefined()
      expect((spot?.y ?? 0) - 1).toBeGreaterThanOrEqual(SURFACE + 3)
    })
  })
})

describe('isPlayerBuilt', () => {
  it.each([
    'oak_planks',
    'stone_bricks',
    'cobblestone_stairs',
    'oak_door',
    'glass',
    'glass_pane',
    'white_stained_glass',
    'chest',
    'torch',
    'wall_torch',
    'white_wool',
    'red_bed',
    'oak_sign',
    'oak_fence',
    'stone_slab',
    'crafting_table',
    'iron_bars',
  ])('counts %s as a player-built block', (name) => {
    expect(isPlayerBuilt(name)).toBe(true)
  })

  it.each([
    'stone',
    'cobblestone',
    'obsidian',
    'netherrack',
    'basalt',
    'blackstone',
    'dirt',
    'gravel',
    'lava',
    'water',
    'air',
    'oak_log',
    'diamond_ore',
    'deepslate',
    'magma_block',
    'oak_leaves',
  ])('does not count %s', (name) => {
    expect(isPlayerBuilt(name)).toBe(false)
  })
})
