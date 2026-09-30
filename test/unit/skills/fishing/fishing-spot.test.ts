import { describe, expect, it } from '@jest/globals'
import { FakeAreaGuard } from '../../../fakes/gathering-fakes.js'
import { findFishingSpot } from '../../../../src/skills/fishing/fishing-spot.js'
import { at, fishingWorld, GROUND } from '../../../fakes/fishing-fakes.js'

describe('findFishingSpot', () => {
  it('stands on firm ground 2 to 4 blocks from open water, at the water’s level', () => {
    const { world } = fishingWorld()

    const spot = findFishingSpot(world, new FakeAreaGuard(), at(0, GROUND + 1, 2))

    expect(spot).toBeDefined()
    if (spot === undefined) return
    expect(world.blockAt(spot.water)).toBe('water')
    expect(spot.stand.y).toBe(GROUND + 1)
    const across = Math.hypot(spot.stand.x - spot.water.x, spot.stand.z - spot.water.z)
    expect(across).toBeGreaterThanOrEqual(2)
    expect(across).toBeLessThanOrEqual(4.5)
  })

  it('picks the standing place nearest to the bot', () => {
    const { world } = fishingWorld()

    const spot = findFishingSpot(world, new FakeAreaGuard(), at(0, GROUND + 1, 2))

    expect(spot?.stand.x).toBeLessThan(10)
  })

  it('refuses a stream one block wide', () => {
    const { world } = fishingWorld()
    for (let x = 10; x <= 14; x += 1)
      for (let z = 0; z <= 4; z += 1) world.set(x, GROUND, z, 'grass_block')
    for (let x = 10; x <= 14; x += 1) world.set(x, GROUND, 2, 'water')

    expect(findFishingSpot(world, new FakeAreaGuard(), at(0, GROUND + 1, 2))).toBeUndefined()
  })

  it('refuses water with something on top of it', () => {
    const { world } = fishingWorld()
    for (let x = 9; x <= 15; x += 1)
      for (let z = -1; z <= 5; z += 1) world.set(x, GROUND + 1, z, 'oak_planks')

    expect(findFishingSpot(world, new FakeAreaGuard(), at(0, GROUND + 1, 2))).toBeUndefined()
  })

  it('does not stand in a protected area', () => {
    const { world } = fishingWorld()
    const guard = new FakeAreaGuard()
    guard.protect('bank', (p) => p.x < 20)

    expect(findFishingSpot(world, guard, at(0, GROUND + 1, 2))).toBeUndefined()
  })

  it('does not stand beside lava', () => {
    const { world } = fishingWorld()
    for (let x = 0; x <= 30; x += 1)
      for (let z = -30; z <= 30; z += 1)
        if (world.blockAt(at(x, GROUND, z)) !== 'water') world.set(x, GROUND + 1, z, 'lava')

    expect(findFishingSpot(world, new FakeAreaGuard(), at(0, GROUND + 1, 2))).toBeUndefined()
  })

  it('finds nothing when there is no water', () => {
    const { world } = fishingWorld()
    for (let x = 10; x <= 14; x += 1)
      for (let z = 0; z <= 4; z += 1) world.set(x, GROUND, z, 'grass_block')

    expect(findFishingSpot(world, new FakeAreaGuard(), at(0, GROUND + 1, 2))).toBeUndefined()
  })
})
