import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { BedFinder } from '../../../../src/skills/sleeping/bed-finder.js'
import {
  bedsExplode,
  colourOfBed,
  isBedName,
  isNight,
} from '../../../../src/skills/sleeping/bed-table.js'
import { findBedSpot } from '../../../../src/skills/sleeping/bed-spot.js'
import { NightWatch } from '../../../../src/skills/sleeping/night-watch.js'
import { BedRegistry } from '../../../../src/state/bed-registry.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'
import { GroveWorld } from '../../../fakes/grove-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const Y = 64
const at = (x: number, z = 0): Position => ({ x, y: Y, z })

describe('bed table', () => {
  it('knows every colour of bed and nothing else', () => {
    expect(isBedName('red_bed')).toBe(true)
    expect(isBedName('light_blue_bed')).toBe(true)
    expect(isBedName('respawn_anchor')).toBe(false)
    expect(isBedName('bed')).toBe(false)
    expect(isBedName(undefined)).toBe(false)
    expect(colourOfBed('light_gray_bed')).toBe('light_gray')
  })

  it('has the night from 12541 to 23458 ticks, and no beds in the Nether or the End', () => {
    expect([12_540, 12_541, 23_458, 23_459, 6000].map(isNight)).toEqual([
      false,
      true,
      true,
      false,
      false,
    ])
    expect(['overworld', 'the_nether', 'the_end', 'minecraft:the_nether'].map(bedsExplode)).toEqual(
      [false, true, true, true],
    )
  })
})

describe('BedFinder', () => {
  async function setup() {
    const world = new GroveWorld({ x0: -40, x1: 60, z0: -40, z1: 40, y0: 50, y1: 90 })
    const registry = new BedRegistry(new FakeClock(0))
    await registry.attach(new InMemoryStateStore())
    return { world, registry, finder: new BedFinder(world, registry) }
  }

  it('lists remembered and visible beds nearest first, counting the two halves of a bed once', async () => {
    const s = await setup()
    s.world.set(10, Y, 0, 'red_bed')
    s.world.set(11, Y, 0, 'red_bed')
    s.world.set(3, Y, 4, 'blue_bed')
    s.registry.note(at(30), 'green')
    s.world.set(30, Y, 0, 'green_bed')

    const found = s.finder.candidates(at(0))

    expect(found.map((b) => b.colour)).toEqual(['blue', 'red', 'green'])
  })

  it('forgets a remembered bed that is gone, and keeps one in a place that is not loaded', async () => {
    const s = await setup()
    s.registry.note(at(5), 'red')
    s.registry.note(at(500), 'blue')

    const found = s.finder.candidates(at(0))

    expect(found).toEqual([{ position: at(500), colour: 'blue' }])
    expect(s.registry.all().map((b) => b.colour)).toEqual(['blue'])
  })

  it('finds nothing in an empty world', async () => {
    const s = await setup()
    expect(s.finder.candidates(at(0))).toEqual([])
  })
})

describe('findBedSpot', () => {
  const guard = { protectedAt: (): undefined => undefined }
  const flat = () => {
    const world = new GroveWorld({ x0: -20, x1: 20, z0: -20, z1: 20, y0: 50, y1: 90 })
    world.ground(-20, -20, 20, 20, Y - 1)
    return world
  }

  it('finds two free cells in a row with room behind the foot to stand', () => {
    const spot = findBedSpot(flat(), guard, at(0), false)

    expect(spot).toBeDefined()
    if (spot === undefined) return
    expect(spot.foot).toEqual(at(0))
    expect(Math.abs(spot.head.x - spot.foot.x) + Math.abs(spot.head.z - spot.foot.z)).toBe(1)
    expect(spot.stand).toEqual({
      x: spot.foot.x * 2 - spot.head.x,
      y: Y,
      z: spot.foot.z * 2 - spot.head.z,
    })
  })

  it('skips cells that are taken, have no ground, or have something above, and protected ones', () => {
    const world = flat()
    world.set(0, Y, 0, 'stone')
    world.set(1, Y + 1, 0, 'stone')
    world.set(-1, Y - 1, 0, 'air')
    const protectedNearOrigin = {
      protectedAt: (p: Position) =>
        Math.abs(p.x) <= 1 && Math.abs(p.z) <= 1 ? { id: 'a', label: 'a' } : undefined,
    }

    const spot = findBedSpot(world, protectedNearOrigin, at(0), false)

    expect(spot).toBeDefined()
    if (spot === undefined) return
    expect(Math.max(Math.abs(spot.foot.x), Math.abs(spot.foot.z))).toBeGreaterThan(1)
  })

  it('with an exact cell uses only that cell, in whichever direction fits', () => {
    const world = flat()
    world.set(0, Y, 1, 'stone')
    world.set(0, Y, -1, 'stone')

    const spot = findBedSpot(world, guard, at(0), true)

    expect(spot?.foot).toEqual(at(0))
    expect(spot?.head).toEqual(at(1))
    world.set(1, Y, 0, 'stone')
    world.set(-1, Y, 0, 'stone')
    expect(findBedSpot(world, guard, at(0), true)).toBeUndefined()
  })

  it('finds nothing without ground in reach, and never uses water', () => {
    const empty = new GroveWorld({ x0: -20, x1: 20, z0: -20, z1: 20, y0: 50, y1: 90 })
    expect(findBedSpot(empty, guard, at(0), false)).toBeUndefined()
    const wet = flat()
    for (let x = -8; x <= 8; x += 1) for (let z = -8; z <= 8; z += 1) wet.set(x, Y, z, 'water')
    expect(findBedSpot(wet, guard, at(0), false)).toBeUndefined()
  })
})

describe('findBedSpot in a room', () => {
  const guard = { protectedAt: (): undefined => undefined }
  /** A 3 by 3 interior (x 3..5, z -11..-9) with stone walls two high around it, on a flat floor. */
  function room(door?: Position) {
    // Only the house is loaded, so nothing outside it can hold a bed.
    const world = new GroveWorld({ x0: 2, x1: 6, z0: -12, z1: -8, y0: 50, y1: 90 })
    world.ground(2, -12, 6, -8, Y - 1, 'oak_planks')
    for (let x = 2; x <= 6; x += 1)
      for (let z = -12; z <= -8; z += 1) {
        const inside = x >= 3 && x <= 5 && z >= -11 && z <= -9
        if (inside) continue
        for (const y of [Y, Y + 1]) world.set(x, y, z, 'oak_planks')
      }
    if (door !== undefined) {
      world.set(door.x, Y, door.z, 'oak_door')
      world.set(door.x, Y + 1, door.z, 'oak_door')
    }
    return world
  }
  const inside = (p: Position): boolean => p.x >= 3 && p.x <= 5 && p.z >= -11 && p.z <= -9
  const middle: Position = { x: 4, y: Y, z: -10 }

  it('puts the bed against a wall inside the room, not in the middle of it', () => {
    const spot = findBedSpot(room(), guard, middle, false)

    expect(spot).toBeDefined()
    if (spot === undefined) return
    expect(inside(spot.foot) && inside(spot.head) && inside(spot.stand)).toBe(true)
    const touching = (p: Position): boolean => p.x === 3 || p.x === 5 || p.z === -11 || p.z === -9
    expect(touching(spot.foot) && touching(spot.head)).toBe(true)
  })

  it('keeps the bed and the standing place away from the doorway when there is another way', () => {
    const door = { x: 4, y: Y, z: -12 }
    const spot = findBedSpot(room(door), guard, middle, false)

    expect(spot).toBeDefined()
    if (spot === undefined) return
    for (const cell of [spot.foot, spot.head, spot.stand])
      expect(Math.abs(cell.x - door.x) + Math.abs(cell.z - door.z)).toBeGreaterThan(1)
  })

  it('still uses a spot beside the door when that is all there is', () => {
    const world = room({ x: 4, y: Y, z: -12 })
    // A 3 by 1 corridor: only the row along the door can hold a bed.
    for (const z of [-10, -9])
      for (const x of [3, 4, 5]) for (const y of [Y, Y + 1]) world.set(x, y, z, 'oak_planks')

    const spot = findBedSpot(world, guard, { x: 4, y: Y, z: -11 }, false)

    expect(spot).toBeDefined()
    expect(spot?.foot.z).toBe(-11)
  })

  it('puts a bed into a protected area when the cell was named, and refuses it otherwise', () => {
    const world = room()
    const protectedHouse = {
      protectedAt: (p: Position) => (inside(p) ? { id: 'house', label: 'house' } : undefined),
    }

    expect(findBedSpot(world, protectedHouse, middle, false)).toBeUndefined()
    const named = findBedSpot(world, protectedHouse, { x: 5, y: Y, z: -10 }, true)
    expect(named?.foot).toEqual({ x: 5, y: Y, z: -10 })
  })
})

describe('NightWatch', () => {
  it('checks every interval until stopped, and survives a failing check', async () => {
    const clock = new FakeClock(0)
    const scheduler = new FakeScheduler(clock)
    let calls = 0
    const watch = new NightWatch(
      () => {
        calls += 1
        return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve()
      },
      scheduler,
      1000,
    )

    watch.start()
    watch.start()
    scheduler.advance(1000)
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    scheduler.advance(1000)
    expect(calls).toBe(2)

    watch.stop()
    scheduler.advance(5000)
    expect(calls).toBe(2)
    expect(scheduler.pendingCount).toBe(0)
  })
})
