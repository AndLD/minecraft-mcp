import { describe, expect, it } from '@jest/globals'
import type { BlockScanner } from '../../../../src/core/block-scanner.port.js'
import type { BlockQuery, BlockInfo } from '../../../../src/core/block-scanner.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import {
  isTerrainBlock,
  structuredSizeFor,
} from '../../../../src/skills/gathering/structured-gather.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })

/** Solid `below` for every cell at or below `surfaceY`, `above` (default air) higher up. */
class ColumnScanner implements BlockScanner {
  constructor(
    private readonly surfaceY: number,
    private readonly below: string,
    private readonly above = 'air',
  ) {}

  blockAt(position: Position): string | undefined {
    return position.y <= this.surfaceY ? this.below : this.above
  }
  knownBlockNames(): readonly string[] {
    return [this.below, this.above]
  }
  findBlocks(_query: BlockQuery): readonly BlockInfo[] {
    return []
  }
  isSolid(position: Position): boolean | undefined {
    return position.y <= this.surfaceY
  }
  sampleBlocks() {
    return []
  }
}

describe('isTerrainBlock', () => {
  it('accepts the plain, common ground blocks', () => {
    for (const name of ['dirt', 'stone', 'cobblestone', 'sand', 'gravel', 'netherrack'])
      expect(isTerrainBlock(name)).toBe(true)
  })

  it('excludes ore, wood, and anything else that needs finding, not planning around', () => {
    for (const name of ['iron_ore', 'oak_log', 'oak_leaves', 'diamond_ore', 'grass_block'])
      expect(isTerrainBlock(name)).toBe(false)
  })
})

describe('structuredSizeFor', () => {
  it('picks a small square footprint over a deep narrow one', () => {
    const world = new ColumnScanner(63, 'dirt')

    const size = structuredSizeFor(world, at(0, 63, 0), 'dirt', 32)

    expect(size.width).toBeLessThanOrEqual(5)
    expect(size.length).toBe(size.width)
    expect(size.depth).toBeLessThanOrEqual(4)
    expect(size.width * size.length * size.depth).toBeGreaterThanOrEqual(32)
  })

  it('never grows a side past 5, however large the count', () => {
    const world = new ColumnScanner(63, 'dirt')

    const size = structuredSizeFor(world, at(0, 63, 0), 'dirt', 500)

    expect(size.width).toBe(5)
    expect(size.length).toBe(5)
  })

  it('picks an exact-fit small footprint for a small count', () => {
    const world = new ColumnScanner(63, 'dirt')

    const size = structuredSizeFor(world, at(0, 63, 0), 'dirt', 8)

    expect(size.width * size.length * size.depth).toBe(8)
  })

  it('widens instead of digging into a different layer below', () => {
    // Only two layers of dirt here (y = 63 and 62); stone starts at 61.
    const world: BlockScanner = {
      blockAt: (p) => (p.y >= 62 ? 'dirt' : 'stone'),
      knownBlockNames: () => ['dirt', 'stone'],
      findBlocks: () => [],
      isSolid: () => true,
      sampleBlocks: () => [],
    }

    const size = structuredSizeFor(world, at(0, 63, 0), 'dirt', 32)

    expect(size.depth).toBeLessThanOrEqual(2) // never deeper than the dirt actually goes
    expect(size.width * size.length * size.depth).toBeGreaterThanOrEqual(32)
  })

  it('still digs at least one layer when the very first cell does not match', () => {
    const world = new ColumnScanner(63, 'stone') // the origin itself is not dirt

    const size = structuredSizeFor(world, at(0, 63, 0), 'dirt', 10)

    expect(size.depth).toBeGreaterThanOrEqual(1)
  })
})
