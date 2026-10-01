import { describe, expect, it } from '@jest/globals'
import {
  boundsOfCells,
  clusterCells,
  findEnclosures,
  type Cell,
} from '../../../../src/skills/farming/discover-shapes.js'

const rect = (x0: number, z0: number, x1: number, z1: number): Cell[] => {
  const cells: Cell[] = []
  for (let x = x0; x <= x1; x += 1) for (let z = z0; z <= z1; z += 1) cells.push({ x, z })
  return cells
}

/** The cells of a one-block-thick square ring. */
const ring = (x0: number, z0: number, x1: number, z1: number): Cell[] =>
  rect(x0, z0, x1, z1).filter((c) => c.x === x0 || c.x === x1 || c.z === z0 || c.z === z1)

describe('clusterCells', () => {
  it('keeps touching cells together and far ones apart', () => {
    const groups = clusterCells([...rect(0, 0, 2, 2), ...rect(10, 10, 11, 11)], 1)

    expect(groups.map((g) => g.length).sort()).toEqual([4, 9])
  })

  it('bridges a one-block gap with a gap of 2, but not a two-block one', () => {
    const split = [...rect(0, 0, 1, 3), ...rect(3, 0, 4, 3)] // one column between
    const wider = [...rect(0, 0, 1, 3), ...rect(4, 0, 5, 3)] // two columns between

    expect(clusterCells(split, 2)).toHaveLength(1)
    expect(clusterCells(wider, 2)).toHaveLength(2)
    expect(clusterCells(split, 1)).toHaveLength(2)
  })

  it('chains a long thin field into one group', () => {
    expect(clusterCells(rect(0, 0, 0, 30), 1)).toHaveLength(1)
  })

  it('has nothing to group when there are no cells', () => {
    expect(clusterCells([], 2)).toEqual([])
  })
})

describe('boundsOfCells', () => {
  it('is the box around the cells', () => {
    expect(boundsOfCells([{ x: 3, z: -2 }, { x: 7, z: 4 }, { x: 5, z: 0 }])).toEqual({
      minX: 3,
      maxX: 7,
      minZ: -2,
      maxZ: 4,
    })
  })
})

describe('findEnclosures', () => {
  it('finds the area a closed ring holds', () => {
    const regions = findEnclosures(ring(0, 0, 5, 4))

    expect(regions).toEqual([{ minX: 1, maxX: 4, minZ: 1, maxZ: 3, cells: 12 }])
  })

  it('finds two pens that share a fence as two enclosures', () => {
    const shared = [...ring(0, 0, 4, 4), ...ring(4, 0, 8, 4)]

    const regions = findEnclosures(shared)

    expect(regions).toHaveLength(2)
    expect(regions.map((r) => r.minX).sort()).toEqual([1, 5])
    expect(regions.every((r) => r.cells === 9)).toBe(true)
  })

  it('finds nothing in a ring with a gap', () => {
    const open = ring(0, 0, 5, 4).filter((c) => !(c.x === 0 && c.z === 2))

    expect(findEnclosures(open)).toEqual([])
  })

  it('finds nothing for a straight fence, or no fence at all', () => {
    expect(findEnclosures(rect(0, 0, 9, 0))).toEqual([])
    expect(findEnclosures([])).toEqual([])
  })

  it('does not let the outside through a diagonal touch of two fence posts', () => {
    // A diamond of posts touching only at corners: its inside is closed to a 4-way walker.
    const diamond: Cell[] = [
      { x: 2, z: 0 },
      { x: 1, z: 1 },
      { x: 3, z: 1 },
      { x: 0, z: 2 },
      { x: 4, z: 2 },
      { x: 1, z: 3 },
      { x: 3, z: 3 },
      { x: 2, z: 4 },
    ]

    const regions = findEnclosures(diamond)

    expect(regions).toHaveLength(1)
    expect(regions[0]?.cells).toBe(5)
  })

  it('reports an inner ring inside a bigger one, and the strip between them', () => {
    const regions = findEnclosures([...ring(0, 0, 10, 10), ...ring(3, 3, 7, 7)])

    expect(regions.map((r) => r.cells).sort((a, b) => a - b)).toEqual([9, 56])
  })
})
