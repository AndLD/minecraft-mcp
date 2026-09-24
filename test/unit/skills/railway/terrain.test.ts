import { describe, expect, it } from '@jest/globals'
import { isPassThrough, TerrainReader } from '../../../../src/skills/railway/terrain.js'
import { FakeAreaGuard } from '../../../fakes/gathering-fakes.js'
import { GroveWorld } from '../../../fakes/grove-fakes.js'

const GROUND = 63

function setup() {
  const world = new GroveWorld({ x0: 0, x1: 20, z0: 0, z1: 20, y0: 40, y1: 90 })
  const guard = new FakeAreaGuard()
  const terrain = new TerrainReader(world, guard, { top: 80, bottom: 50 })
  return { world, guard, terrain }
}

describe('TerrainReader', () => {
  it('finds natural ground, looking down through air, plants, and trees', () => {
    const s = setup()
    s.world.set(2, GROUND, 2, 'grass_block')
    s.world.set(2, GROUND + 1, 2, 'short_grass')
    s.world.set(2, GROUND + 2, 2, 'oak_log')
    s.world.set(2, GROUND + 3, 2, 'oak_leaves')

    expect(s.terrain.column(2, 2)).toEqual({ kind: 'land', y: GROUND })
  })

  it('reports the top of water, and lava', () => {
    const s = setup()
    s.world.set(3, GROUND, 3, 'water')
    s.world.set(3, GROUND - 1, 3, 'dirt')
    s.world.set(4, GROUND, 4, 'lava')

    expect(s.terrain.column(3, 3)).toEqual({ kind: 'water', y: GROUND })
    expect(s.terrain.column(4, 4)).toEqual({ kind: 'lava', y: GROUND })
  })

  it('tells what somebody built from natural ground', () => {
    const s = setup()
    s.world.set(5, GROUND, 5, 'stone_bricks')
    s.world.set(6, GROUND, 6, 'stone')
    s.world.set(7, GROUND, 7, 'iron_ore')

    expect(s.terrain.column(5, 5).kind).toBe('structure')
    expect(s.terrain.column(6, 6).kind).toBe('land')
    expect(s.terrain.column(7, 7).kind).toBe('land')
  })

  it('marks ground in a protected area', () => {
    const s = setup()
    s.world.set(8, GROUND, 8, 'dirt')
    s.guard.protect('house', (p) => p.x === 8 && p.z === 8)

    expect(s.terrain.column(8, 8)).toEqual({ kind: 'protected', y: GROUND })
  })

  it('is not loaded outside the loaded box, and when nothing solid is in range', () => {
    const s = setup()

    expect(s.terrain.column(50, 50).kind).toBe('unloaded')
    expect(s.terrain.column(9, 9).kind).toBe('unloaded') // loaded, but nothing solid down to the bottom
  })

  it('remembers what it read', () => {
    const s = setup()
    s.world.set(2, GROUND, 2, 'dirt')
    const first = s.terrain.column(2, 2)
    s.world.set(2, GROUND, 2, 'lava')

    expect(s.terrain.column(2, 2)).toBe(first)
  })
})

describe('isPassThrough', () => {
  it('is air, plants, snow, and a tree’s wood and leaves', () => {
    for (const name of ['air', 'short_grass', 'poppy', 'snow', 'oak_log', 'birch_leaves']) expect(isPassThrough(name)).toBe(true)
    for (const name of ['dirt', 'stone', 'water', 'oak_planks']) expect(isPassThrough(name)).toBe(false)
  })
})
