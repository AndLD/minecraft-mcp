import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { SiteSafety } from '../../../../src/skills/construction/site-safety.js'
import { cellKey, StandingSpotChooser } from '../../../../src/skills/construction/standing-spot.js'
import {
  isOpenAir,
  isPlanned,
  isReplaceable,
} from '../../../../src/skills/construction/block-match.js'
import { ConstructionWorld } from '../../../fakes/construction-fakes.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })

describe('StandingSpotChooser', () => {
  it('does not stand on the cell it is asked to keep intact under its feet', () => {
    const world = new ConstructionWorld()
    const from = at(2.5, 64, 2.5)
    const chooser = new StandingSpotChooser(world)

    expect(chooser.choose({ target: at(2, 63, 2), from, reserved: new Set() })).toBe(from)
    const moved = chooser.choose({ target: at(2, 63, 2), from, reserved: new Set(), notOn: at(2, 63, 2) })

    expect(moved).toBeDefined()
    expect(moved).not.toBe(from)
    expect(Math.floor(moved?.x ?? 0) === 2 && Math.floor(moved?.z ?? 0) === 2).toBe(false)
  })

  it('keeps the bot where it is when it already reaches the cell', () => {
    const world = new ConstructionWorld()
    const from = at(2.5, 64, 2.5)

    const spot = new StandingSpotChooser(world).choose({
      target: at(3, 64, 5),
      from,
      reserved: new Set(),
    })

    expect(spot).toBe(from)
  })

  it('finds a place within reach when the bot is far, on solid ground', () => {
    const world = new ConstructionWorld()

    const spot = new StandingSpotChooser(world).choose({
      target: at(3, 64, 5),
      from: at(0.5, 64, 40),
      reserved: new Set(),
    })

    expect(spot).toBeDefined()
    expect(Math.hypot((spot?.x ?? 0) - 3.5, (spot?.z ?? 0) - 5.5)).toBeLessThan(4.5)
    expect(spot?.y).toBe(64)
  })

  it('never picks the target cell, nor a cell that still has to be built', () => {
    const world = new ConstructionWorld()
    const reserved = new Set<string>()
    for (let x = -1; x <= 8; x += 1)
      for (let z = 2; z <= 8; z += 1) reserved.add(cellKey(at(x, 64, z))) // everything near is reserved

    const spot = new StandingSpotChooser(world).choose({
      target: at(3, 64, 5),
      from: at(0.5, 64, 40),
      reserved,
    })

    if (spot !== undefined) expect(reserved.has(cellKey(spot))).toBe(false)
  })

  it('moves off the target cell when the bot stands in it', () => {
    const world = new ConstructionWorld()

    const spot = new StandingSpotChooser(world).choose({
      target: at(3, 64, 5),
      from: at(3.5, 64, 5.5),
      reserved: new Set(),
    })

    expect(spot).toBeDefined()
    expect(cellKey(spot ?? at(0, 0, 0))).not.toBe(cellKey(at(3, 64, 5)))
  })

  it('prefers a place outside the volume being built, when there is one', () => {
    const world = new ConstructionWorld()
    const inside = (cell: Position): boolean =>
      cell.x >= 0 && cell.x <= 5 && cell.z >= 0 && cell.z <= 5
    const chooser = new StandingSpotChooser(world)

    const spot = chooser.choose({
      target: at(3, 64, 3),
      from: at(2.5, 64, 2.5), // inside, and it would do
      reserved: new Set(),
      avoid: inside,
    })

    expect(spot).toBeDefined()
    expect(inside(spot ?? at(2, 64, 2))).toBe(false)
  })

  it('stands inside when nothing outside reaches the cell', () => {
    const world = new ConstructionWorld()
    const chooser = new StandingSpotChooser(world)

    const spot = chooser.choose({
      target: at(3, 64, 3),
      from: at(2.5, 64, 2.5),
      reserved: new Set(),
      avoid: () => true, // everywhere is "inside"
    })

    expect(spot).toEqual(at(2.5, 64, 2.5))
  })

  it('lines up with the target along the axis when asked (a door has to face along the wall)', () => {
    const world = new ConstructionWorld()
    const chooser = new StandingSpotChooser(world)

    const spot = chooser.choose({
      target: at(3, 64, 5),
      from: at(0.5, 64, 40),
      reserved: new Set(),
      alignAxis: 'z',
    })

    expect(spot).toBeDefined()
    expect(Math.floor(spot?.x ?? 0)).toBe(3)
    const along = Math.abs(Math.floor(spot?.z ?? 0) - 5)
    expect(along).toBeGreaterThanOrEqual(1)
    expect(along).toBeLessThanOrEqual(3)
  })

  it('does not keep a place that is beside the target when it has to be in line', () => {
    const world = new ConstructionWorld()
    const chooser = new StandingSpotChooser(world)

    const spot = chooser.choose({
      target: at(3, 64, 5),
      from: at(1.5, 64, 5.5), // beside it: reaches, but not in line
      reserved: new Set(),
      alignAxis: 'z',
    })

    expect(Math.floor(spot?.x ?? 0)).toBe(3)
  })

  it('keeps the place when it is already in line', () => {
    const world = new ConstructionWorld()
    const from = at(3.5, 64, 2.5)

    expect(
      new StandingSpotChooser(world).choose({
        target: at(3, 64, 5),
        from,
        reserved: new Set(),
        alignAxis: 'z',
      }),
    ).toBe(from)
  })

  it('avoids ground next to lava, and fluids', () => {
    const world = new ConstructionWorld()
    world.setBlock(at(4, 64, 3), 'lava')
    const chooser = new StandingSpotChooser(world)

    const spot = chooser.choose({
      target: at(4, 64, 5),
      from: at(0.5, 64, 40),
      reserved: new Set(),
    })

    expect(spot).toBeDefined()
    expect(Math.hypot((spot?.x ?? 0) - 4.5, (spot?.z ?? 0) - 3.5)).toBeGreaterThan(1.5)
  })

  it('finds nothing when no ground is known around the cell', () => {
    const world = new ConstructionWorld()
    for (let x = -6; x <= 12; x += 1)
      for (let z = -2; z <= 12; z += 1)
        for (let y = 58; y <= 66; y += 1) world.unloaded.add(cellKey(at(x, y, z)))

    expect(
      new StandingSpotChooser(world).choose({
        target: at(3, 64, 5),
        from: at(0.5, 64, 40),
        reserved: new Set(),
      }),
    ).toBeUndefined()
  })

  it('stands below a cell too, when the ground allows', () => {
    const world = new ConstructionWorld()
    for (let x = 0; x <= 6; x += 1)
      for (let z = 3; z <= 7; z += 1) world.setBlock(at(x, 64, z), 'stone') // a plateau
    const spot = new StandingSpotChooser(world).choose({
      target: at(3, 66, 5),
      from: at(0.5, 65, 5.5),
      reserved: new Set(),
    })

    expect(spot?.y).toBeGreaterThanOrEqual(64)
  })
})

describe('SiteSafety', () => {
  it('reports lava in or next to the volume, and nothing otherwise', () => {
    const world = new ConstructionWorld()
    const safety = new SiteSafety(world, world)
    const plan = {
      name: 'p',
      steps: [
        { kind: 'place' as const, at: at(0, 64, 0), block: 'stone' },
        { kind: 'place' as const, at: at(3, 66, 3), block: 'stone' },
      ],
    }
    expect(safety.hazards(plan)).toEqual([])

    world.setBlock(at(4, 64, 3), 'lava')
    world.setBlock(at(-1, 64, 0), 'lava')
    expect(safety.hazards(plan)).toEqual(['2 lava block(s) in or next to the building site'])

    world.setBlock(at(9, 64, 9), 'lava') // far away
    expect(safety.hazards(plan)).toHaveLength(1)
    expect(safety.hazards({ name: 'empty', steps: [] })).toEqual([])
  })

  it('wants a torch in a dark cell with none nearby', () => {
    const world = new ConstructionWorld()
    const safety = new SiteSafety(world, world)

    expect(safety.needsTorch(at(2, 64, 2), 8)).toBe(true)
    world.light.set('2,64,2', 8)
    expect(safety.needsTorch(at(2, 64, 2), 8)).toBe(false)
  })

  it('does not put a torch next to another', () => {
    const world = new ConstructionWorld()
    const safety = new SiteSafety(world, world)
    world.setBlock(at(5, 64, 2), 'wall_torch')

    expect(safety.needsTorch(at(2, 64, 2), 8)).toBe(false) // 3 blocks away
    expect(safety.needsTorch(at(20, 64, 2), 8)).toBe(true)
  })

  it('does not know what to do about cells it cannot see', () => {
    const world = new ConstructionWorld()
    world.unloaded.add('2,64,2')

    expect(new SiteSafety(world, world).needsTorch(at(2, 64, 2), 8)).toBe(false)
  })
})

describe('block matching', () => {
  it('tells air, replaceable blocks, and planned blocks apart', () => {
    expect(isOpenAir('air')).toBe(true)
    expect(isOpenAir('short_grass')).toBe(false)
    expect(isOpenAir(undefined)).toBe(false)
    expect(isReplaceable('short_grass')).toBe(true)
    expect(isReplaceable('water')).toBe(true)
    expect(isReplaceable('stone')).toBe(false)
    expect(isReplaceable(undefined)).toBe(false)
    expect(isPlanned('stone', 'stone')).toBe(true)
    expect(isPlanned('stone', 'dirt')).toBe(false)
    expect(isPlanned('stone', undefined)).toBe(false)
    expect(isPlanned('torch', 'wall_torch')).toBe(true)
    expect(isPlanned('soul_torch', 'soul_wall_torch')).toBe(true)
    expect(isPlanned('torch', 'stone')).toBe(false)
    expect(isPlanned('water_bucket', 'water')).toBe(true)
    expect(isPlanned('wheat_seeds', 'wheat')).toBe(true)
    expect(isPlanned('carrot', 'carrots')).toBe(true)
    expect(isPlanned('potato', 'potatoes')).toBe(true)
    expect(isPlanned('beetroot_seeds', 'beetroots')).toBe(true)
    expect(isPlanned('wheat_seeds', 'dirt')).toBe(false)
  })
})
