import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { expectedShape, headingOf, isCorner } from '../../../../src/skills/railway/rail-orientation.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })

describe('headingOf', () => {
  it('names the four ways to a next-door cell (north is -z, east is +x)', () => {
    const here = at(5, 64, 5)

    expect(headingOf(here, at(6, 64, 5))).toBe('east')
    expect(headingOf(here, at(4, 64, 5))).toBe('west')
    expect(headingOf(here, at(5, 64, 6))).toBe('south')
    expect(headingOf(here, at(5, 64, 4))).toBe('north')
  })

  it('has no heading for a cell that is not next to it', () => {
    expect(headingOf(at(0, 0, 0), at(2, 0, 0))).toBeUndefined()
    expect(headingOf(at(0, 0, 0), at(1, 0, 1))).toBeUndefined()
    expect(headingOf(at(0, 0, 0), at(0, 0, 0))).toBeUndefined()
  })
})

describe('expectedShape', () => {
  it('is a straight run along the axis it goes', () => {
    const east = [at(0, 64, 0), at(1, 64, 0), at(2, 64, 0)]
    const south = [at(0, 64, 0), at(0, 64, 1), at(0, 64, 2)]

    expect(expectedShape(east, 1)).toBe('east_west')
    expect(expectedShape(south, 1)).toBe('north_south')
  })

  it('gives the first and the last rail the axis of their only neighbour', () => {
    const line = [at(0, 64, 0), at(1, 64, 0), at(2, 64, 0)]

    expect(expectedShape(line, 0)).toBe('east_west')
    expect(expectedShape(line, 2)).toBe('east_west')
    expect(expectedShape([at(0, 64, 0), at(0, 64, -1)], 0)).toBe('north_south')
  })

  it.each([
    ['south_east', at(0, 64, 1), at(1, 64, 0)],
    ['south_west', at(0, 64, 1), at(-1, 64, 0)],
    ['north_east', at(0, 64, -1), at(1, 64, 0)],
    ['north_west', at(0, 64, -1), at(-1, 64, 0)],
  ])('bends into %s where the line turns', (shape, from, to) => {
    expect(expectedShape([from, at(0, 64, 0), to], 1)).toBe(shape)
    expect(expectedShape([to, at(0, 64, 0), from], 1)).toBe(shape)
  })

  it('rises towards the higher neighbour, whichever side it is on', () => {
    const up = [at(0, 64, 0), at(1, 65, 0), at(2, 66, 0)]
    const down = [at(0, 66, 0), at(1, 65, 0), at(2, 64, 0)]
    const north = [at(0, 64, 0), at(0, 65, -1)]

    expect(expectedShape(up, 0)).toBe('ascending_east')
    expect(expectedShape(up, 1)).toBe('ascending_east')
    expect(expectedShape(down, 1)).toBe('ascending_west')
    expect(expectedShape(down, 2)).toBe('ascending_west')
    expect(expectedShape(north, 0)).toBe('ascending_north')
  })

  it('has no shape for a cell that is not there, a lone one, or a break in the line', () => {
    expect(expectedShape([at(0, 64, 0)], 5)).toBeUndefined()
    expect(expectedShape([at(0, 64, 0)], 0)).toBeUndefined()
    expect(expectedShape([at(0, 64, 0), at(5, 64, 0)], 0)).toBeUndefined()
  })
})

describe('isCorner', () => {
  it('is true only where the two neighbours are not in a straight line', () => {
    const cells = [at(0, 64, 0), at(1, 64, 0), at(2, 64, 0), at(2, 64, 1)]

    expect(isCorner(cells, 1)).toBe(false)
    expect(isCorner(cells, 2)).toBe(true)
  })

  it('is false at the ends, out of range, and for a broken line', () => {
    const cells = [at(0, 64, 0), at(1, 64, 0)]

    expect(isCorner(cells, 0)).toBe(false)
    expect(isCorner(cells, 1)).toBe(false)
    expect(isCorner(cells, 7)).toBe(false)
    expect(isCorner([at(0, 64, 0), at(1, 64, 0), at(5, 64, 5)], 1)).toBe(false)
  })
})
