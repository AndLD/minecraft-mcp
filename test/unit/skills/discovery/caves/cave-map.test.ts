import { describe, expect, it } from '@jest/globals'
import {
  canStandBeside,
  CaveMap,
  reachedKeys,
} from '../../../../../src/skills/discovery/caves/cave-map.js'
import { CaveWorld } from '../../../../fakes/cave-fakes.js'

const at = (x: number, y: number, z: number) => ({ x, y, z })

/** A corridor along x at y 60 (floor 59), ten long. */
function corridor(): CaveWorld {
  return new CaveWorld().carve(at(0, 60, 0), at(10, 61, 0))
}

describe('CaveMap.standable', () => {
  it('accepts open feet and head over a solid floor, and refuses solid, low, or floorless cells', () => {
    const world = corridor()
      .carve(at(20, 60, 0), at(20, 60, 0))
      .carve(at(30, 55, 0), at(30, 61, 0))
    const map = new CaveMap(world)

    expect(map.standable(at(5, 60, 0))).toBe(true)
    expect(map.standable(at(5, 59, 0))).toBe(false) // inside rock
    expect(map.standable(at(20, 60, 0))).toBe(false) // one block of headroom
    expect(map.standable(at(30, 60, 0))).toBe(false) // nothing under the feet
  })

  it('refuses a floor that hurts and cells with lava near', () => {
    const world = corridor()
    world.setBlock(at(3, 59, 0), 'magma_block')
    world.setBlock(at(8, 60, 1), 'lava')
    const map = new CaveMap(world)

    expect(map.standable(at(3, 60, 0))).toBe(false)
    expect(map.standable(at(8, 60, 0))).toBe(false)
    expect(map.standable(at(7, 60, 0))).toBe(false) // the lava is diagonal, still too close
    expect(map.standable(at(5, 60, 0))).toBe(true)
  })

  it('refuses standing in water', () => {
    const world = corridor()
    world.setBlock(at(4, 60, 0), 'water')

    expect(new CaveMap(world).standable(at(4, 60, 0))).toBe(false)
  })
})

describe('CaveMap.reach', () => {
  it('walks a corridor, nearest first, and counts the steps', () => {
    const { cells, truncated } = new CaveMap(corridor()).reach(at(0, 60, 0), 20)

    expect(truncated).toBe(false)
    expect(cells.map((cell) => cell.position.x)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(cells.at(-1)?.steps).toBe(10)
  })

  it('stays within the radius', () => {
    const { cells } = new CaveMap(corridor()).reach(at(0, 60, 0), 4)

    expect(Math.max(...cells.map((cell) => cell.position.x))).toBe(4)
  })

  it('steps up one block and down as far as three, but not four', () => {
    const world = new CaveWorld()
      .carve(at(0, 60, 0), at(0, 62, 0))
      .carve(at(1, 61, 0), at(1, 63, 0)) // one up
      .carve(at(2, 58, 0), at(2, 63, 0)) // three down from 61
      .carve(at(3, 54, 0), at(3, 63, 0)) // four down from 58
    const reached = new CaveMap(world)
      .reach(at(0, 60, 0), 10)
      .cells.map((cell) => `${String(cell.position.x)},${String(cell.position.y)}`)

    expect(reached).toContain('1,61')
    expect(reached).toContain('2,58')
    expect(reached).not.toContain('3,54')
  })

  it('does not step up under a low ceiling', () => {
    const world = new CaveWorld()
      .carve(at(0, 60, 0), at(0, 61, 0))
      .carve(at(1, 61, 0), at(1, 62, 0))

    expect(new CaveMap(world).reach(at(0, 60, 0), 5).cells).toHaveLength(1)
  })

  it('keeps away from lava: cells beside it are not reached, and nothing behind them', () => {
    const world = corridor()
    world.setBlock(at(5, 60, 1), 'lava')

    const xs = new CaveMap(world).reach(at(0, 60, 0), 20).cells.map((cell) => cell.position.x)

    expect(Math.max(...xs)).toBe(3)
  })

  it('reports a truncated map when there are more cells than the limit', () => {
    const big = new CaveWorld().carve(at(-10, 60, -10), at(10, 61, 10))

    const { cells, truncated } = new CaveMap(big).reach(at(0, 60, 0), 20, 50)

    expect(truncated).toBe(true)
    expect(cells).toHaveLength(50)
  })
})

describe('CaveMap roofs and sky', () => {
  it('knows a cell under natural rock from one under sky, a tree, or a house', () => {
    const world = corridor()
    world.carve(at(20, 101, 0), at(20, 101, 0), 'air')
    world.setBlock(at(30, 103, 0), 'oak_planks')
    world.setBlock(at(40, 103, 0), 'oak_leaves')
    const map = new CaveMap(world)

    expect(map.roofed(at(5, 60, 0))).toBe(true)
    expect(map.roofed(at(20, 101, 0))).toBe(false)
    expect(map.roofed(at(30, 101, 0))).toBe(false)
    expect(map.roofed(at(40, 101, 0))).toBe(false)
    expect(map.skyAbove(at(20, 101, 0))).toBe(true)
    expect(map.skyAbove(at(5, 60, 0))).toBe(false)
  })

  it('finds the nearest cave mouth from the surface', () => {
    const world = new CaveWorld().carve(at(12, 101, 0), at(30, 102, 0))
    for (let x = 12; x <= 30; x += 1) world.carve(at(x, 103, -1), at(x, 106, 1), 'stone')

    expect(new CaveMap(world).findMouth(at(0, 101, 0), 40)).toEqual(at(12, 101, 0))
    expect(new CaveMap(new CaveWorld()).findMouth(at(0, 101, 0), 40)).toBeUndefined()
  })
})

describe('CaveMap.classify', () => {
  it('calls a roofed tunnel a cave', () => {
    const map = new CaveMap(corridor())

    expect(map.classify(map.reach(at(0, 60, 0), 20).cells)).toBe('cave')
    expect(map.classify([])).toBe('cave')
  })

  it('calls a deep cut open to the sky a ravine', () => {
    // A slot from the surface down to y 80, each step a drop of three: walkable, open above.
    const world = new CaveWorld()
    for (let step = 0; step < 4; step += 1)
      world.carve(at(step * 2, 101 - step * 3, 0), at(step * 2 + 1, 110, 0))
    const map = new CaveMap(world)

    const region = map.classify(map.reach(at(0, 101, 0), 20).cells)

    expect(region).toBe('ravine')
  })
})

describe('canStandBeside', () => {
  it('is true beside a reachable cell or above one, false for a block nobody can get next to', () => {
    const world = corridor()
    const reached = reachedKeys(new CaveMap(world).reach(at(0, 60, 0), 20).cells)

    expect(canStandBeside(at(5, 60, 1), reached)).toBe(true) // in the wall beside the corridor
    expect(canStandBeside(at(5, 59, 0), reached)).toBe(true) // in the floor: reached from above
    expect(canStandBeside(at(5, 60, 5), reached)).toBe(false) // deep in the rock
    expect(canStandBeside(at(5, 60, 1), new Set())).toBe(false)
  })
})
