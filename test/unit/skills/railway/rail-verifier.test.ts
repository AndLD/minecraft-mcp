import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import type { RailAccess, RailState } from '../../../../src/core/rail.port.js'
import { RailVerifier, type RailLine } from '../../../../src/skills/railway/rail-verifier.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { AutoScheduler, InstantNavigator, skillContext } from '../../../fakes/gathering-fakes.js'
import { GroveDigger, GrovePlacer, GroveWorld } from '../../../fakes/grove-fakes.js'

const Y = 64
const at = (x: number, z = 0): Position => ({ x, y: Y, z })
const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`

/** Reads rails back from the fake world: name from the blocks, shape and power from what a test sets. */
class FakeRails implements RailAccess {
  readonly shapes = new Map<string, string>()
  readonly power = new Map<string, boolean>()

  constructor(private readonly world: GroveWorld) {}

  stateAt(position: Position): RailState | undefined {
    const name = this.world.blockAt(position)
    if (name === undefined || !name.endsWith('rail')) return undefined
    return { name, shape: this.shapes.get(key(position)), powered: name === 'powered_rail' ? this.power.get(key(position)) : undefined }
  }
}

function setup() {
  const world = new GroveWorld({ x0: -5, x1: 30, z0: -5, z1: 5, y0: 50, y1: 90 })
  const rails = new FakeRails(world)
  const navigator = new InstantNavigator()
  const digger = new GroveDigger(world)
  const placer = new GrovePlacer(world)
  const verifier = new RailVerifier({
    rails,
    blocks: world,
    navigator,
    digger,
    placer,
    scheduler: new AutoScheduler(new FakeClock(0)),
  })
  /** A line of `n` rails east, the first `poweredCount` of them powered, all in their right shape and powered. */
  function line(n: number, poweredCount: number): RailLine {
    const cells = Array.from({ length: n }, (_, i) => at(i))
    for (const [i, cell] of cells.entries()) {
      const powered = i < poweredCount
      world.set(cell.x, cell.y, cell.z, powered ? 'powered_rail' : 'rail')
      rails.shapes.set(key(cell), 'east_west')
      if (powered) rails.power.set(key(cell), true)
    }
    return { cells, powered: cells.slice(0, poweredCount), torches: [at(0, -1)] }
  }
  return { world, rails, navigator, digger, placer, verifier, line }
}

describe('RailVerifier', () => {
  it('finds nothing wrong with a line laid right, without touching it', async () => {
    const s = setup()

    const result = await s.verifier.verify(s.line(6, 2), skillContext().context)

    expect(result).toEqual({ checked: 6, problems: [], repaired: 0 })
    expect(s.placer.placed).toEqual([])
    expect(s.digger.dug).toEqual([])
  })

  it('places again a rail that is missing', async () => {
    const s = setup()
    const line = s.line(6, 2)
    s.world.set(4, Y, 0, 'air')

    const result = await s.verifier.verify(line, skillContext().context)

    expect(s.placer.placed).toEqual([{ item: 'rail', at: at(4) }])
    expect(result).toMatchObject({ problems: [], repaired: 1 })
  })

  it('breaks a wrongly bent rail and places it again as the same kind', async () => {
    const s = setup()
    const line = s.line(6, 2)
    s.rails.shapes.set(key(at(1)), 'north_south') // a powered rail
    s.rails.shapes.set(key(at(3)), 'south_east')

    await s.verifier.verify(line, skillContext().context)

    expect(s.digger.dug).toEqual([at(1), at(3)])
    expect(s.placer.placed).toEqual([
      { item: 'powered_rail', at: at(1) },
      { item: 'rail', at: at(3) },
    ])
  })

  it('replaces a rail of the wrong kind', async () => {
    const s = setup()
    const line = s.line(4, 2)
    s.world.set(0, Y, 0, 'rail') // should be powered

    await s.verifier.verify(line, skillContext().context)

    expect(s.digger.dug).toContainEqual(at(0))
    expect(s.placer.placed).toContainEqual({ item: 'powered_rail', at: at(0) })
  })

  it('sets a torch again when a powered rail is unpowered and its torch is gone', async () => {
    const s = setup()
    const line = s.line(4, 2)
    s.rails.power.set(key(at(0)), false)

    const result = await s.verifier.verify(line, skillContext().context)

    expect(s.placer.placed).toEqual([{ item: 'redstone_torch', at: at(0, -1) }])
    expect(result.problems).toEqual([expect.objectContaining({ kind: 'unpowered' })])
  })

  it('does not set a torch that is there, and reports the rail as still unpowered', async () => {
    const s = setup()
    const line = s.line(4, 2)
    s.world.set(0, Y, -1, 'redstone_torch')
    s.rails.power.set(key(at(0)), false)

    const result = await s.verifier.verify(line, skillContext().context)

    expect(s.placer.placed).toEqual([])
    expect(result.problems).toHaveLength(1)
    expect(result.repaired).toBe(0)
  })

  it('reports what a repair cannot put right', async () => {
    const s = setup()
    const line = s.line(4, 2)
    s.rails.shapes.set(key(at(2)), 'north_south')
    s.placer.placeAt = () => Promise.resolve({ ok: false as const, error: { reason: 'failed' as const, message: 'no' } })

    const result = await s.verifier.verify(line, skillContext().context)

    // The bent rail was broken and could not be placed again, so what is left is a hole.
    expect(result.problems).toEqual([{ at: at(2), kind: 'missing', expected: 'rail', found: 'air' }])
    expect(result.repaired).toBe(0)
  })

  it('walks to a rail it cannot see, and reports one that stays out of view as unverified', async () => {
    const s = setup()
    const line = s.line(3, 1)
    const far = at(50)
    const result = await s.verifier.verify({ cells: [...line.cells, far], powered: line.powered, torches: line.torches }, skillContext().context)

    expect(s.navigator.trips.some((t) => t.target.x === 50)).toBe(true)
    expect(result.problems).toEqual([{ at: far, kind: 'unverified', expected: 'rail', found: undefined }])
    expect(s.placer.placed).toEqual([])
  })

  it('stops when cancelled', async () => {
    const s = setup()
    const { context, controller } = skillContext()
    controller.abort()

    const result = await s.verifier.verify(s.line(6, 2), context)

    expect(result.problems).toEqual([])
    expect(s.placer.placed).toEqual([])
  })
})
