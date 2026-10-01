import { describe, expect, it } from '@jest/globals'
import {
  directionFromYaw,
  rectangleFromFacing,
} from '../../../../src/skills/site-leveling/facing.js'

describe('directionFromYaw', () => {
  it('snaps the four cardinal yaws exactly', () => {
    expect(directionFromYaw(0)).toBe('north') // yaw 0 faces -z
    expect(directionFromYaw(Math.PI / 2)).toBe('west')
    expect(directionFromYaw(Math.PI)).toBe('south')
    expect(directionFromYaw(-Math.PI / 2)).toBe('east')
  })

  it('snaps an in-between yaw to the nearer cardinal', () => {
    expect(directionFromYaw(0.3)).toBe('north') // close to 0, still north
    expect(directionFromYaw(Math.PI / 2 - 0.3)).toBe('west') // close to 90 degrees
  })
})

describe('rectangleFromFacing', () => {
  it('runs length forward and width to the right, facing north', () => {
    const rect = rectangleFromFacing({ x: 10, z: 10 }, 'north', 3, 5)

    // North: forward is -z, right is +x.
    expect(rect).toEqual({ x1: 10, z1: 6, x2: 12, z2: 10 })
  })

  it('runs length forward and width to the right, facing east', () => {
    const rect = rectangleFromFacing({ x: 10, z: 10 }, 'east', 3, 5)

    // East: forward is +x, right is +z.
    expect(rect).toEqual({ x1: 10, z1: 10, x2: 14, z2: 12 })
  })

  it('is a single cell for a 1x1 plot', () => {
    const rect = rectangleFromFacing({ x: 0, z: 0 }, 'south', 1, 1)

    expect(rect).toEqual({ x1: 0, z1: 0, x2: 0, z2: 0 })
  })
})
