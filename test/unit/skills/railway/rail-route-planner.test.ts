import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { isCorner } from '../../../../src/skills/railway/rail-orientation.js'
import {
  RailRoutePlanner,
  type RailRoute,
  type RouteRequest,
} from '../../../../src/skills/railway/rail-route-planner.js'
import { FakeAreaGuard } from '../../../fakes/gathering-fakes.js'
import { GroveWorld } from '../../../fakes/grove-fakes.js'

const GROUND = 63
const at = (x: number, y: number, z: number): Position => ({ x, y, z })

function setup() {
  const world = new GroveWorld({ x0: -30, x1: 60, z0: -40, z1: 40, y0: 20, y1: 110 })
  world.ground(-30, -40, 60, 40, GROUND)
  const guard = new FakeAreaGuard()
  return { world, guard, planner: new RailRoutePlanner({ blocks: world, guard }) }
}

const request = (over: Partial<RouteRequest> = {}): RouteRequest => ({
  start: at(0, GROUND + 1, 0),
  end: at(10, GROUND + 1, 0),
  layout: 'surface',
  depth: undefined,
  ...over,
})

function routeOf(result: ReturnType<RailRoutePlanner['plan']>): RailRoute {
  if (!result.ok) throw new Error(`${result.error.reason}: ${result.error.message}`)
  return result.value
}

/** Every rail next to the last, never more than a block up or down, corners and their neighbours level. */
function expectValid(route: RailRoute): void {
  const { cells } = route
  for (let i = 1; i < cells.length; i += 1) {
    const a = cells[i - 1] as Position
    const b = cells[i] as Position
    expect(Math.abs(a.x - b.x) + Math.abs(a.z - b.z)).toBe(1)
    expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1)
  }
  for (let i = 1; i < cells.length - 1; i += 1) {
    if (!isCorner(cells, i)) continue
    expect((cells[i - 1] as Position).y).toBe((cells[i] as Position).y)
    expect((cells[i + 1] as Position).y).toBe((cells[i] as Position).y)
  }
}

describe('RailRoutePlanner: surface', () => {
  it('runs straight over flat ground, one rail per block, on top of the ground', () => {
    const s = setup()

    const route = routeOf(s.planner.plan(request()))

    expect(route.layout).toBe('surface')
    expect(route.cells).toHaveLength(11)
    expect(route.cells.every((c) => c.y === GROUND + 1 && c.z === 0)).toBe(true)
    expect(route).toMatchObject({ cuts: 0, decks: 0 })
    expect(route.cover.every((c) => c === 0)).toBe(true)
    expectValid(route)
  })

  it('takes the shortest way with the fewest turns to a corner of the map', () => {
    const s = setup()

    const route = routeOf(s.planner.plan(request({ end: at(8, GROUND + 1, 6) })))

    expect(route.cells).toHaveLength(15)
    expect(route.cells.filter((_, i) => isCorner(route.cells, i))).toHaveLength(1)
    expectValid(route)
  })

  it('goes around lava, a player-made wall, and a protected area', () => {
    const s = setup()
    s.world.set(5, GROUND, 0, 'lava')
    for (let z = -2; z <= 2; z += 1) s.world.set(6, GROUND, z, 'stone_bricks')
    s.guard.protect('house', (p) => p.x === 8 && p.z >= -3 && p.z <= 3)

    const route = routeOf(s.planner.plan(request()))

    const at = (x: number, z: number) => route.cells.some((c) => c.x === x && c.z === z)
    expect(at(5, 0)).toBe(false)
    expect(route.cells.some((c) => c.x === 6 && c.z >= -2 && c.z <= 2)).toBe(false)
    expect(route.cells.some((c) => c.x === 8 && c.z >= -3 && c.z <= 3)).toBe(false)
    expect(route.cells.filter((_, i) => isCorner(route.cells, i)).length).toBeGreaterThan(0)
    expectValid(route)
  })

  it('climbs a low rise on decks and slopes, one block per rail', () => {
    const s = setup()
    for (let x = 4; x <= 8; x += 1) s.world.ground(x, -40, x, 40, GROUND + 3, 'grass_block')
    for (let x = 4; x <= 8; x += 1)
      for (let y = GROUND; y < GROUND + 3; y += 1) s.world.ground(x, -40, x, 40, y, 'dirt')

    const route = routeOf(s.planner.plan(request({ end: at(14, GROUND + 1, 0) })))

    expectValid(route)
    expect(Math.max(...route.cells.map((c) => c.y))).toBeGreaterThan(GROUND + 1)
    expect(route.cells[route.cells.length - 1]?.y).toBe(GROUND + 1)
  })

  it('cuts through a tall rise instead of climbing it', () => {
    const s = setup()
    for (let x = 4; x <= 8; x += 1)
      for (let y = GROUND; y <= GROUND + 10; y += 1)
        s.world.ground(x, -40, x, 40, y, y === GROUND + 10 ? 'grass_block' : 'stone')

    const route = routeOf(s.planner.plan(request({ end: at(14, GROUND + 1, 0) })))

    expectValid(route)
    expect(route.cuts).toBeGreaterThanOrEqual(10)
    expect(route.cells.filter((c) => c.x >= 4 && c.x <= 8).every((c) => c.y <= GROUND + 3)).toBe(
      true,
    )
  })

  it('bridges a ravine with support blocks at rail level', () => {
    const s = setup()
    for (let x = 4; x <= 6; x += 1)
      for (let y = GROUND - 8; y <= GROUND; y += 1) s.world.ground(x, -40, x, 40, y, 'air')
    for (let x = 4; x <= 6; x += 1) s.world.ground(x, -40, x, 40, GROUND - 9, 'stone')

    const route = routeOf(s.planner.plan(request()))

    expect(route.cells.every((c) => c.y === GROUND + 1)).toBe(true)
    expect(route.decks).toBe(3)
    expectValid(route)
  })

  it('bridges a lake at the water surface, with the rail above the water', () => {
    const s = setup()
    for (let x = 4; x <= 7; x += 1) {
      s.world.ground(x, -40, x, 40, GROUND - 1, 'dirt')
      s.world.ground(x, -40, x, 40, GROUND, 'water')
    }

    const route = routeOf(s.planner.plan(request()))

    expect(route.cells.every((c) => c.y === GROUND + 1)).toBe(true)
    expect(route.decks).toBe(4)
  })

  it('cuts through trees and plants that are in the way', () => {
    const s = setup()
    s.world.set(3, GROUND + 1, 0, 'oak_log')
    s.world.set(3, GROUND + 2, 0, 'oak_leaves')
    s.world.set(5, GROUND + 1, 0, 'short_grass')

    const route = routeOf(s.planner.plan(request()))

    expect(route.cuts).toBeGreaterThanOrEqual(2)
    expect(route.cells.every((c) => c.z === 0)).toBe(true)
  })

  it('keeps corners and the rails beside them level even on a slope', () => {
    const s = setup()
    for (let x = -30; x <= 60; x += 1)
      s.world.ground(x, -40, x, 40, GROUND + Math.floor(Math.max(0, x) / 3), 'grass_block')
    for (let x = -30; x <= 60; x += 1)
      for (let y = GROUND; y < GROUND + Math.floor(Math.max(0, x) / 3); y += 1)
        s.world.ground(x, -40, x, 40, y, 'dirt')
    for (let z = -4; z <= 3; z += 1) s.world.set(9, GROUND + 3, z, 'stone_bricks')

    const route = routeOf(
      s.planner.plan(request({ start: at(0, GROUND + 1, 0), end: at(15, GROUND + 6, 0) })),
    )

    expectValid(route)
  })

  it('reports where and why a line cannot pass', () => {
    const s = setup()
    for (let z = -40; z <= 40; z += 1) s.world.set(5, GROUND, z, 'lava')

    const result = s.planner.plan(request())

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_route' } })
  })

  it('refuses the same place, a route too long, and ends that are lava, protected, or not loaded', () => {
    const s = setup()
    s.world.set(0, GROUND, 0, 'lava')
    s.guard.protect('base', (p) => p.x === 10)

    expect(s.planner.plan(request())).toMatchObject({ error: { reason: 'lava' } }) // the start column is lava
    expect(setup().planner.plan(request({ end: at(0, GROUND + 1, 0) }))).toMatchObject({
      error: { reason: 'same_place' },
    })
    expect(s.planner.plan(request({ start: at(1, GROUND + 1, 0) }))).toMatchObject({
      error: { reason: 'protected_area' },
    })
    expect(setup().planner.plan(request({ end: at(500, GROUND + 1, 0) }))).toMatchObject({
      error: { reason: 'too_long' },
    })
    expect(
      setup().planner.plan(request({ start: at(90, GROUND + 1, 0), end: at(100, GROUND + 1, 0) })),
    ).toMatchObject({
      error: { reason: 'unloaded' },
    })
  })

  it('says when the search area is not loaded around a route', () => {
    const s = setup()
    // Ground only along a thin strip: everything beside it reads as not loaded.
    const strip = new GroveWorld({ x0: 0, x1: 12, z0: 0, z1: 0, y0: 20, y1: 110 })
    strip.ground(0, 0, 12, 0, GROUND)
    strip.set(5, GROUND, 0, 'lava')
    const planner = new RailRoutePlanner({ blocks: strip, guard: s.guard })

    const result = planner.plan(request({ end: at(12, GROUND + 1, 0) }))

    expect(result).toMatchObject({ ok: false, error: { reason: 'unloaded' } })
  })
})

describe('RailRoutePlanner: underground', () => {
  function rock() {
    const s = setup()
    for (let y = GROUND - 30; y < GROUND; y += 1) s.world.ground(-30, -40, 60, 40, y, 'stone')
    return s
  }

  it('runs below the surface in the middle and comes up to it at both ends', () => {
    const s = rock()

    const route = routeOf(
      s.planner.plan(request({ end: at(14, GROUND + 1, 0), layout: 'underground', depth: 4 })),
    )

    expect(route.layout).toBe('underground')
    expect(route.cover[0]).toBe(0)
    expect(route.cover[route.cover.length - 1]).toBe(0)
    expect(Math.max(...route.cover)).toBe(4)
    expect(route.cuts).toBeGreaterThan(20)
    const middle = route.cells[Math.floor(route.cells.length / 2)]
    expect(middle?.y).toBeLessThanOrEqual(GROUND + 1 - 4)
    expectValid(route)
  })

  it('keeps below a shallow lake, coming up again after it', () => {
    const s = rock()
    for (let x = 8; x <= 14; x += 1)
      for (let y = GROUND - 1; y <= GROUND; y += 1) s.world.ground(x, -40, x, 40, y, 'water')

    const route = routeOf(
      s.planner.plan(request({ end: at(22, GROUND + 1, 0), layout: 'underground', depth: 3 })),
    )

    for (const cell of route.cells.filter((c) => c.x >= 8 && c.x <= 14))
      expect(cell.y).toBeLessThanOrEqual(GROUND - 3)
    expect(route.cells[route.cells.length - 1]?.y).toBe(GROUND + 1)
    expectValid(route)
  })

  it('cannot tunnel under a lake deeper than the ramp allows', () => {
    const s = rock()
    for (let x = 4; x <= 10; x += 1)
      for (let y = GROUND - 8; y <= GROUND; y += 1) s.world.ground(x, -40, x, 40, y, 'water')

    const result = s.planner.plan(
      request({ end: at(14, GROUND + 1, 0), layout: 'underground', depth: 3 }),
    )

    expect(result).toMatchObject({ ok: false })
  })
})

describe('RailRoutePlanner: auto', () => {
  it('stays on the surface where the ground is easy', () => {
    expect(routeOf(setup().planner.plan(request({ layout: 'auto' }))).layout).toBe('surface')
  })

  it('takes a tunnel when the surface would take too much earthwork', () => {
    const s = setup()
    for (let y = GROUND - 30; y < GROUND; y += 1) s.world.ground(-30, -40, 60, 40, y, 'stone')
    // A plateau far too tall to climb, across the whole way: the line must cut through it, two blocks per rail.
    for (let x = 1; x <= 15; x += 1)
      for (let y = GROUND; y <= GROUND + 30; y += 1)
        s.world.ground(x, -40, x, 40, y, y === GROUND + 30 ? 'grass_block' : 'stone')

    const route = routeOf(
      s.planner.plan(request({ layout: 'auto', end: at(16, GROUND + 1, 0), depth: 4 })),
    )

    expect(route.layout).toBe('underground')
  })

  it('reports the surface problem when neither works', () => {
    const s = setup()
    for (let z = -40; z <= 40; z += 1) s.world.set(5, GROUND, z, 'lava')

    expect(s.planner.plan(request({ layout: 'auto' }))).toMatchObject({ ok: false })
  })
})
