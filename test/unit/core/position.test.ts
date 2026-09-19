import { describe, expect, it } from '@jest/globals'
import { distanceBetween, roundPosition } from '../../../src/core/position.js'

describe('position helpers', () => {
  it('measures straight-line distance in three dimensions', () => {
    expect(distanceBetween({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBe(5)
    expect(distanceBetween({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 })).toBe(0)
    expect(distanceBetween({ x: 0, y: 0, z: 0 }, { x: 2, y: 3, z: 6 })).toBe(7)
  })

  it('rounds to one decimal', () => {
    expect(roundPosition({ x: 1.26, y: 64, z: -3.04 })).toEqual({ x: 1.3, y: 64, z: -3 })
  })
})
