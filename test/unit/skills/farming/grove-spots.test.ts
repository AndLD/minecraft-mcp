import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { GroveSpotFinder, type SpotRequest } from '../../../../src/skills/farming/grove-spots.js'
import { treeFor } from '../../../../src/skills/farming/tree-table.js'
import { FarmRegistry } from '../../../../src/state/farm-registry.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeAreaGuard } from '../../../fakes/gathering-fakes.js'
import { GroveWorld } from '../../../fakes/grove-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const GROUND = 64
const at = (x: number, y: number, z: number): Position => ({ x, y, z })
const rect = (x0: number, z0: number, x1: number, z1: number) => ({ from: at(x0, GROUND, z0), to: at(x1, GROUND, z1) })

async function setup() {
  const world = new GroveWorld({ x0: -10, x1: 40, z0: -10, z1: 40, y0: 50, y1: 90 })
  world.ground(-10, -10, 40, 40, GROUND)
  const guard = new FakeAreaGuard()
  const farms = new FarmRegistry(new FakeClock(0))
  await farms.attach(new InMemoryStateStore())
  const finder = new GroveSpotFinder({ blocks: world, guard, farms })
  return { world, guard, farms, finder }
}

const oak = treeFor('oak')
const darkOak = treeFor('dark_oak')
if (oak === undefined || darkOak === undefined) throw new Error('table missing species')

const request = (over: Partial<SpotRequest> = {}): SpotRequest => ({
  tree: oak,
  big: false,
  count: 100,
  region: { rect: rect(0, 0, 12, 12) },
  spacing: 4,
  ...over,
})

function found(result: ReturnType<GroveSpotFinder['find']>) {
  if ('error' in result) throw new Error(result.error)
  return result
}

describe('GroveSpotFinder', () => {
  it('fills a plot with spots one spacing apart, on top of the ground', async () => {
    const { finder } = await setup()

    const result = found(finder.find(request()))

    expect(result.capacity).toBe(16)
    expect(result.spots).toHaveLength(16)
    expect(result.spots.every((spot) => spot.y === GROUND + 1 && spot.size === 1)).toBe(true)
    for (const a of result.spots)
      for (const b of result.spots)
        if (a !== b) expect(Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z))).toBeGreaterThanOrEqual(4)
  })

  it('spreads fewer trees than the plot holds across it', async () => {
    const { finder } = await setup()

    const result = found(finder.find(request({ count: 4 })))

    expect(result.spots).toHaveLength(4)
    expect(new Set(result.spots.map((spot) => spot.x)).size).toBeGreaterThan(1)
    expect(result.capacity).toBe(16)
  })

  it('turns down ground a sapling cannot stand on', async () => {
    const { finder, world } = await setup()
    world.ground(0, 0, 12, 12, GROUND, 'stone')

    const result = found(finder.find(request()))

    expect(result.spots).toEqual([])
    expect(result.rejected).toMatchObject({ not_plantable_ground: 169 })
  })

  it('turns down cells with no room above, but lets leaves overhead through', async () => {
    const { finder, world } = await setup()
    // Above the height the surface is looked for, so it counts as a roof, not as the ground.
    world.set(0, GROUND + 6, 0, 'stone')
    world.set(4, GROUND + 6, 0, 'oak_leaves')

    const result = found(finder.find(request()))

    expect(result.spots).not.toContainEqual(expect.objectContaining({ x: 0, z: 0 }))
    expect(result.spots).toContainEqual(expect.objectContaining({ x: 4, z: 0 }))
    expect(result.rejected.blocked_above).toBeGreaterThan(0)
  })

  it('finds the surface when the ground is not at the given level', async () => {
    const { finder, world } = await setup()
    world.ground(0, 0, 12, 12, GROUND + 2)
    world.ground(0, 0, 12, 12, GROUND, 'dirt')
    world.ground(0, 0, 12, 12, GROUND + 1, 'dirt')

    const result = found(finder.find(request()))

    expect(result.spots.every((spot) => spot.y === GROUND + 3)).toBe(true)
  })

  it('skips protected areas, except the grove’s own', async () => {
    const { finder, guard } = await setup()
    guard.protect('house', (p) => p.x <= 6)

    const others = found(finder.find(request()))
    const own = found(finder.find(request({ own: { id: 'farm-1', label: 'house' } })))

    expect(others.spots.every((spot) => spot.x > 6)).toBe(true)
    expect(others.rejected.protected).toBeGreaterThan(0)
    expect(own.spots.some((spot) => spot.x <= 6)).toBe(true)
  })

  it('leaves a keep-out area clear', async () => {
    const { finder } = await setup()

    const result = found(
      finder.find(request({ region: { rect: rect(0, 0, 12, 12), keepOut: rect(3, 3, 9, 9) } })),
    )

    expect(result.spots.some((spot) => spot.x >= 3 && spot.x <= 9 && spot.z >= 3 && spot.z <= 9)).toBe(false)
    expect(result.rejected.keep_out).toBeGreaterThan(0)
  })

  it('keeps a block away from other farms', async () => {
    const { finder, farms } = await setup()
    farms.register({ kind: 'field', bounds: rect(0, 0, 5, 12) })

    const result = found(finder.find(request()))

    expect(result.spots.every((spot) => spot.x >= 7)).toBe(true)
    expect(result.rejected.near_other_farm).toBeGreaterThan(0)
  })

  it('keeps clear of doors and paths', async () => {
    const { finder, world } = await setup()
    world.set(1, GROUND + 1, 1, 'oak_door')
    world.set(9, GROUND, 9, 'dirt_path')

    const result = found(finder.find(request()))

    expect(result.spots).not.toContainEqual(expect.objectContaining({ x: 0, z: 0 }))
    expect(result.spots).not.toContainEqual(expect.objectContaining({ x: 8, z: 8 }))
    expect(result.rejected.near_path_or_door).toBeGreaterThan(0)
  })

  it('keeps its distance from saplings and grown trees already there', async () => {
    const { finder, world } = await setup()
    world.set(6, GROUND + 1, 6, 'oak_sapling')
    world.set(2, GROUND + 1, 10, 'oak_log')

    const result = found(finder.find(request()))

    for (const spot of result.spots) {
      expect(Math.max(Math.abs(spot.x - 6), Math.abs(spot.z - 6))).toBeGreaterThanOrEqual(4)
      expect(Math.max(Math.abs(spot.x - 2), Math.abs(spot.z - 10))).toBeGreaterThanOrEqual(4)
    }
  })

  it('ignores a log with no ground under it (part of a build, not a trunk)', async () => {
    const { finder, world } = await setup()
    world.set(2, GROUND + 5, 2, 'oak_log')

    const result = found(finder.find(request()))

    expect(result.spots).toContainEqual(expect.objectContaining({ x: 0, z: 0 }))
  })

  it('finds 2x2 sites for the big variants, only on level ground', async () => {
    const { finder, world } = await setup()
    world.set(1, GROUND + 1, 0, 'dirt') // a step in the ground
    world.set(1, GROUND, 0, 'dirt')

    const result = found(
      finder.find(request({ tree: darkOak, big: true, spacing: 7, count: 100 })),
    )

    expect(result.spots.length).toBeGreaterThan(0)
    expect(result.spots.every((spot) => spot.size === 2)).toBe(true)
    expect(result.spots).not.toContainEqual(expect.objectContaining({ x: 0, z: 0 }))
    expect(result.rejected.uneven_ground).toBeGreaterThan(0)
  })

  it('reports cells it cannot see as not loaded', async () => {
    const { finder } = await setup()

    const result = found(finder.find(request({ region: { rect: rect(60, 60, 64, 64) } })))

    expect(result.spots).toEqual([])
    expect(result.rejected.unloaded).toBeGreaterThan(0)
  })

  it('refuses an area that is too large', async () => {
    const { finder } = await setup()

    const result = finder.find(request({ region: { rect: rect(0, 0, 100, 100) } }))

    expect(result).toMatchObject({ error: expect.stringContaining('larger than') })
  })
})
