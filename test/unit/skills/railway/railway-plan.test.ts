import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import type { WorkStep } from '../../../../src/skills/construction/work-plan.types.js'
import type { RailRoute } from '../../../../src/skills/railway/rail-route-planner.js'
import { buildRailwayPlan, type RailwayOptions } from '../../../../src/skills/railway/railway-plan.js'
import { GroveWorld } from '../../../fakes/grove-fakes.js'

const GROUND = 63
const at = (x: number, y: number, z: number): Position => ({ x, y, z })

function setup() {
  const world = new GroveWorld({ x0: -20, x1: 60, z0: -20, z1: 20, y0: 30, y1: 100 })
  world.ground(-20, -20, 60, 20, GROUND)
  return world
}

const straight = (n: number, y = GROUND + 1, z = 0): Position[] => Array.from({ length: n }, (_, i) => at(i, y, z))

const routeOf = (cells: Position[], over: Partial<RailRoute> = {}): RailRoute => ({
  cells,
  layout: 'surface',
  cuts: 0,
  decks: 0,
  cost: 0,
  cover: cells.map(() => 0),
  ...over,
})

const options = (over: Partial<RailwayOptions> = {}): RailwayOptions => ({
  variant: 'economy',
  spacing: 8,
  supportBlock: 'cobblestone',
  ...over,
})

const places = (steps: readonly WorkStep[], block: string): WorkStep[] =>
  steps.filter((s) => s.kind === 'place' && s.block === block)

describe('buildRailwayPlan', () => {
  it('lays rails and powered rails along a flat line, each on the block below, waiting for its cell to be clear', () => {
    const world = setup()

    const built = buildRailwayPlan(routeOf(straight(21)), world, options())

    const rails = built.plan.steps.filter((s) => s.kind === 'place' && (s.block === 'rail' || s.block === 'powered_rail'))
    expect(rails).toHaveLength(21)
    expect(places(built.plan.steps, 'powered_rail')).toHaveLength(6)
    for (const step of rails)
      expect(step).toMatchObject({ against: { x: 0, y: -1, z: 0 }, passable: true, clearedFirst: true, branch: 'line' })
    expect(built.plan).toMatchObject({ standing: 'inside', hazards: 'end_branch' })
    expect(built.plan.name).toBe('railway 21 rails (economy, surface)')
    expect(built.powered).toHaveLength(6)
  })

  it('sets a redstone torch beside each run of powered rails, level with it, on solid ground', () => {
    const world = setup()

    const built = buildRailwayPlan(routeOf(straight(21)), world, options())

    expect(built.torches).toHaveLength(3)
    for (const torch of built.torches) {
      expect(torch.z).toBe(-1) // the north side is tried first
      expect(torch.y).toBe(GROUND + 1)
    }
    expect(places(built.plan.steps, 'redstone_torch')).toHaveLength(3)
    expect(built.notes).toEqual([])
  })

  it('puts the torch on the south side when the north cell is taken', () => {
    const world = setup()
    world.set(0, GROUND + 1, -1, 'stone_bricks')

    const built = buildRailwayPlan(routeOf(straight(3)), world, options())

    expect(built.torches[0]).toEqual(at(0, GROUND + 1, 1))
  })

  it('digs a niche for the torch in a tunnel wall', () => {
    const world = setup()
    for (const z of [-1, 1]) for (const y of [GROUND + 1, GROUND + 2]) world.ground(-5, z, 10, z, y, 'stone')

    const built = buildRailwayPlan(routeOf(straight(6)), world, options())

    const niche = built.plan.steps.find((s) => s.kind === 'break' && s.at.z === -1 && s.at.y === GROUND + 1)
    expect(niche).toMatchObject({ kind: 'break', needs: at(0, GROUND + 1, 0), branch: 'line' })
    expect(built.torches[0]).toEqual(at(0, GROUND + 1, -1))
  })

  it('lays a support block under a torch where the ground is missing', () => {
    const world = setup()
    world.set(0, GROUND, -1, 'air')
    world.set(0, GROUND, 1, 'air')

    const built = buildRailwayPlan(routeOf(straight(3)), world, options())

    expect(built.plan.steps).toContainEqual(
      expect.objectContaining({ kind: 'place', at: at(0, GROUND, -1), block: 'cobblestone' }),
    )
  })

  it('lays a plain rail where no torch can go, and says so', () => {
    const world = setup()
    world.ground(-5, -1, 30, -1, GROUND + 1, 'stone_bricks')
    world.ground(-5, 1, 30, 1, GROUND + 1, 'stone_bricks')

    const built = buildRailwayPlan(routeOf(straight(21)), world, options())

    expect(built.notes.length).toBeGreaterThan(0)
    expect(built.notes[0]).toContain('No room for a torch')
    expect(built.torches).toEqual([])
    expect(places(built.plan.steps, 'powered_rail')).toEqual([])
    expect(places(built.plan.steps, 'rail')).toHaveLength(21)
    expect(built.plan.warnings).toEqual(built.notes)
  })

  it('moves the torch along a powered run when the first rail has no room, in the rich variant', () => {
    const world = setup()
    world.set(0, GROUND + 1, -1, 'stone_bricks')
    world.set(0, GROUND + 1, 1, 'stone_bricks')

    const built = buildRailwayPlan(routeOf(straight(12)), world, options({ variant: 'rich' }))

    expect(built.torches[0]).toMatchObject({ x: 1 })
    expect(places(built.plan.steps, 'powered_rail')).toHaveLength(12)
  })

  it('cuts what is in the rail cell and the headroom, each cut after the rail before it', () => {
    const world = setup()
    world.set(2, GROUND + 1, 0, 'dirt')
    world.set(2, GROUND + 2, 0, 'oak_leaves')
    world.set(3, GROUND + 1, 0, 'short_grass') // replaceable: no cut

    const built = buildRailwayPlan(routeOf(straight(5)), world, options())

    const cuts = built.plan.steps.filter((s) => s.kind === 'break')
    expect(cuts).toEqual([
      { kind: 'break', at: at(2, GROUND + 1, 0), branch: 'line', needs: at(1, GROUND + 1, 0) },
      { kind: 'break', at: at(2, GROUND + 2, 0), branch: 'line', needs: at(1, GROUND + 1, 0) },
    ])
  })

  it('lays a support block where the ground is missing, and none where it is there', () => {
    const world = setup()
    world.set(2, GROUND, 0, 'air')
    world.set(3, GROUND, 0, 'water')

    const built = buildRailwayPlan(routeOf(straight(5)), world, options({ supportBlock: 'dirt' }))

    const decks = places(built.plan.steps, 'dirt').filter((s) => s.at.y === GROUND)
    expect(decks.map((s) => s.at)).toEqual([at(2, GROUND, 0), at(3, GROUND, 0)])
  })

  it('sets a block behind the first rail so a cart resting on it starts by itself, unless one is there', () => {
    const world = setup()

    const open = buildRailwayPlan(routeOf(straight(6)), world, options())
    world.set(-1, GROUND + 1, 0, 'stone')
    const walled = buildRailwayPlan(routeOf(straight(6)), world, options())

    expect(open.buffer).toEqual(at(-1, GROUND + 1, 0))
    expect(open.plan.steps[0]).toMatchObject({ kind: 'place', at: at(-1, GROUND + 1, 0), block: 'cobblestone' })
    expect(walled.buffer).toBeUndefined()
  })

  it('has no buffer for a one-rail line', () => {
    expect(buildRailwayPlan(routeOf(straight(1)), setup(), options()).buffer).toBeUndefined()
  })

  it('lights a tunnel where there is ground above, and only there', () => {
    const world = setup()
    const cover = [0, 1, 2, 2, 2, 2, 2, 2, 2, 1, 0, 0, 0]

    const built = buildRailwayPlan(routeOf(straight(13), { layout: 'underground', cover }), world, options())

    const lights = built.plan.steps.filter((s) => s.kind === 'light')
    expect(lights.map((s) => s.at.x)).toEqual([6])
    expect(lights[0]).toMatchObject({ minLight: 8, spacing: 6, branch: 'line' })
  })

  it('does not put a rail in a place another rail of the line takes for a torch', () => {
    const world = setup()
    // A line that doubles back beside itself: the cell beside the first rail is the second leg's rail.
    const cells = [at(0, GROUND + 1, 0), at(1, GROUND + 1, 0), at(2, GROUND + 1, 0), at(2, GROUND + 1, 1), at(1, GROUND + 1, 1), at(0, GROUND + 1, 1)]

    const built = buildRailwayPlan(routeOf(cells), world, options())

    for (const torch of built.torches)
      expect(cells.some((c) => c.x === torch.x && c.y === torch.y && c.z === torch.z)).toBe(false)
  })
})
