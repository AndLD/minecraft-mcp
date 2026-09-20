import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import type { WorkPlan, WorkStep } from '../../../../src/skills/construction/work-plan.types.js'
import { ExcavationRegistry } from '../../../../src/skills/excavation/excavation-registry.js'
import {
  PitProvider,
  QuarryProvider,
  ShaftProvider,
} from '../../../../src/skills/excavation/providers/dig-down.js'
import {
  BranchMineProvider,
  StaircaseDownProvider,
  TunnelProvider,
} from '../../../../src/skills/excavation/providers/tunnels.js'
import { lowestLayer } from '../../../../src/skills/excavation/excavate-skill.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })
type Break = Extract<WorkStep, { kind: 'break' }>
type Light = Extract<WorkStep, { kind: 'light' }>
const breaks = (plan: WorkPlan): Break[] => plan.steps.filter((s): s is Break => s.kind === 'break')
const lights = (plan: WorkPlan): Light[] => plan.steps.filter((s): s is Light => s.kind === 'light')
const ladders = (plan: WorkPlan) => plan.steps.filter((s) => s.kind === 'place')
const asPlan = (result: WorkPlan | { error: string }): WorkPlan => {
  if ('error' in result) throw new Error(result.error)
  return result
}
const keys = (steps: readonly WorkStep[]): string[] =>
  steps.map((s) => `${String(s.at.x)},${String(s.at.y)},${String(s.at.z)}`)
const context = (origin: Position, minY = -64) => ({ origin, minY })

describe('PitProvider', () => {
  const pit = new PitProvider()
  const plan = (params: object, origin = at(10, 63, 20)) =>
    asPlan(pit.generate(pit.params.parse(params), context(origin)))

  it('digs every cell of every layer, from the top down', () => {
    const p = plan({ width: 3, length: 3, depth: 2, exit: 'none' })

    expect(breaks(p)).toHaveLength(18)
    expect(new Set(keys(breaks(p))).size).toBe(18)
    const layers = breaks(p).map((s) => s.at.y)
    expect(layers.slice(0, 9).every((y) => y === 63)).toBe(true)
    expect(layers.slice(9).every((y) => y === 62)).toBe(true)
    expect(p.name).toBe('pit 3x3x2')
  })

  it('makes each column its own chain, so a hazard ends only that column', () => {
    const p = plan({ width: 2, length: 2, depth: 3, exit: 'none' })

    const chains = new Map<string, number>()
    for (const s of breaks(p)) chains.set(s.branch ?? '', (chains.get(s.branch ?? '') ?? 0) + 1)
    expect(chains.size).toBe(4)
    expect([...chains.values()].every((n) => n === 3)).toBe(true)
  })

  it('puts a ladder in the west wall column after every layer', () => {
    const p = plan({ width: 3, length: 5, depth: 3 })

    const ls = ladders(p)
    expect(ls).toHaveLength(3)
    expect(ls.map((s) => s.at)).toEqual([at(10, 63, 22), at(10, 62, 22), at(10, 61, 22)])
    expect(ls[0]).toMatchObject({ block: 'ladder', against: { x: -1, y: 0, z: 0 } })
    // Each ladder comes right after the layer it belongs to.
    const order = p.steps.map((s) => s.kind)
    expect(order.indexOf('place')).toBe(15) // after the first 15 breaks
  })

  it('needs no ladder for one layer, or when told not to', () => {
    expect(ladders(plan({ width: 3, length: 3, depth: 1 }))).toEqual([])
    expect(ladders(plan({ width: 3, length: 3, depth: 4, exit: 'none' }))).toEqual([])
  })

  it('works from inside, ends chains at hazards, and mines veins; no cavity checks', () => {
    const p = plan({ width: 2, length: 2, depth: 2 })

    expect(p).toMatchObject({ standing: 'inside', hazards: 'end_branch', veins: { maxSize: 64 } })
    expect(p.cavityCheck).toBe(false)
    expect(breaks(p).every((s) => s.probe === undefined)).toBe(true)
  })

  it('starts at the ground block two blocks east of the bot', () => {
    expect(pit.defaultOrigin(at(5.5, 64, -3.5))).toEqual(at(7, 63, -4))
  })

  it('validates sizes', () => {
    expect(pit.params.safeParse({ width: 0, length: 3, depth: 2 }).success).toBe(false)
    expect(pit.params.safeParse({ width: 3, length: 40, depth: 2 }).success).toBe(false)
    expect(pit.params.safeParse({ width: 3, length: 3, depth: 300 }).success).toBe(false)
    expect(pit.params.safeParse({ width: 3, length: 3 }).success).toBe(false)
  })
})

describe('ShaftProvider', () => {
  const shaft = new ShaftProvider()

  it('is one block by one by default, and checks for cavities everywhere but above', () => {
    const p = asPlan(shaft.generate(shaft.params.parse({ depth: 6 }), context(at(10, 63, 20))))

    expect(breaks(p)).toHaveLength(6)
    expect(p.cavityCheck).toBe(true)
    const probe = breaks(p)[0]?.probe ?? []
    expect(probe).toHaveLength(5)
    expect(probe.some((o) => o.y === 1)).toBe(false)
    expect(ladders(p)).toHaveLength(6)
  })

  it('can be wider', () => {
    const p = asPlan(
      shaft.generate(
        shaft.params.parse({ depth: 2, width: 2, length: 2, exit: 'none' }),
        context(at(0, 63, 0)),
      ),
    )

    expect(breaks(p)).toHaveLength(8)
  })
})

describe('QuarryProvider', () => {
  const quarry = new QuarryProvider()
  const make = (params: object, origin: Position, minY = -64) =>
    quarry.generate(quarry.params.parse(params), context(origin, minY))

  it('digs down to 9 above the bedrock by default: y = -55 in the overworld', () => {
    const p = asPlan(make({ width: 5, length: 5 }, at(10, 63, 10)))

    const ys = breaks(p).map((s) => s.at.y)
    expect(Math.max(...ys)).toBe(63)
    expect(Math.min(...ys)).toBe(-55)
    expect(breaks(p)).toHaveLength(5 * 5 * 119)
    expect(ladders(p)).toHaveLength(119)
    expect(p.name).toBe('quarry 5x5 to y=-55')
  })

  it('takes a target level, or a number of layers above the bedrock', () => {
    expect(
      Math.min(
        ...breaks(asPlan(make({ width: 2, length: 2, to_y: 40 }, at(0, 63, 0)))).map((s) => s.at.y),
      ),
    ).toBe(40)
    expect(
      Math.min(
        ...breaks(asPlan(make({ width: 2, length: 2, above_bedrock: 20 }, at(0, 63, 0)))).map(
          (s) => s.at.y,
        ),
      ),
    ).toBe(-44)
  })

  it('counts the bottom from 0 in the Nether and the End', () => {
    expect(lowestLayer('overworld')).toBe(-64)
    expect(lowestLayer('minecraft:overworld')).toBe(-64)
    expect(lowestLayer('the_nether')).toBe(0)
    expect(lowestLayer('minecraft:the_end')).toBe(0)
    const p = asPlan(make({ width: 2, length: 2 }, at(0, 100, 0), 0))
    expect(Math.min(...breaks(p).map((s) => s.at.y))).toBe(9)
  })

  it('refuses both a level and a height above the bedrock, a target in the bedrock, and one above the start', () => {
    expect(
      quarry.params.safeParse({ width: 2, length: 2, to_y: 10, above_bedrock: 9 }).success,
    ).toBe(false)
    expect(make({ width: 2, length: 2, to_y: -64 }, at(0, 63, 0))).toEqual({
      error: 'The target level y = -64 is at or below the bedrock (the lowest layer is -64).',
    })
    expect(make({ width: 2, length: 2, to_y: 70 }, at(0, 63, 0))).toMatchObject({
      error: expect.stringContaining('above where the dig starts'),
    })
  })

  it('has a depth limit', () => {
    expect(make({ width: 2, length: 2, above_bedrock: 1 }, at(0, 400, 0))).toMatchObject({
      error: expect.stringContaining('the limit is 256'),
    })
  })

  it('needs no ladder for a single layer', () => {
    expect(ladders(asPlan(make({ width: 2, length: 2, to_y: 63 }, at(0, 63, 0))))).toEqual([])
  })
})

describe('TunnelProvider', () => {
  const tunnel = new TunnelProvider()
  const make = (params: object, origin = at(0, 50, 0)) =>
    asPlan(tunnel.generate(tunnel.params.parse(params), context(origin)))

  it('is 1 wide and 2 high by default, length blocks long, with no side branches', () => {
    const p = make({ direction: 'north', length: 10 })

    expect(breaks(p)).toHaveLength(20)
    expect(p.name).toBe('tunnel 1x2x10 north')
    expect(new Set(breaks(p).map((s) => s.branch))).toEqual(new Set(['main']))
    expect(keys(breaks(p)).slice(0, 4)).toEqual(['0,50,0', '0,51,0', '0,50,-1', '0,51,-1'])
  })

  it.each([
    ['north', '0,50,-4'],
    ['south', '0,50,4'],
    ['east', '4,50,0'],
    ['west', '-4,50,0'],
  ] as const)('goes %s', (direction, lastFloorCell) => {
    const p = make({ direction, length: 5 })

    expect(keys(breaks(p))).toContain(lastFloorCell)
  })

  it('can be wider and taller, measured to the right of the heading', () => {
    const p = make({ direction: 'north', length: 2, width: 3, height: 4 })

    expect(breaks(p)).toHaveLength(24)
    expect(keys(breaks(p))).toContain('2,53,-1') // the third column to the right (east), the top row, the second section
  })

  it('puts a torch every torch_spacing blocks, required, on the floor', () => {
    const p = make({ direction: 'east', length: 14 })

    expect(lights(p).map((s) => s.at)).toEqual([at(5, 50, 0), at(11, 50, 0)])
    expect(lights(p).every((s) => s.required === true && s.spacing === 6 && s.minLight === 7)).toBe(
      true,
    )
    expect(lights(make({ direction: 'east', length: 14, torch_spacing: 0 }))).toEqual([])
    expect(
      lights(make({ direction: 'east', length: 14, torch_spacing: 4, min_light: 5 })).map(
        (s) => s.minLight,
      ),
    ).toEqual([5, 5, 5])
  })

  it('checks every neighbour but the way back for a cave, and ends a hazard at its own chain', () => {
    const p = make({ direction: 'north', length: 3 })

    expect(p).toMatchObject({ cavityCheck: true, hazards: 'end_branch', standing: 'inside' })
    const probe = breaks(p)[0]?.probe ?? []
    expect(probe).toHaveLength(5)
    expect(probe.some((o) => o.z === 1)).toBe(false) // behind (south) is where the bot came from
    expect(probe.some((o) => o.z === -1)).toBe(true)
  })

  it('starts where the bot stands', () => {
    expect(tunnel.defaultOrigin(at(3.7, 40.2, -8.5))).toEqual(at(3, 40, -9))
  })

  it('validates its numbers', () => {
    expect(tunnel.params.safeParse({ direction: 'up', length: 5 }).success).toBe(false)
    expect(tunnel.params.safeParse({ direction: 'north', length: 0 }).success).toBe(false)
    expect(tunnel.params.safeParse({ direction: 'north', length: 5, height: 1 }).success).toBe(
      false,
    )
    expect(tunnel.params.safeParse({ direction: 'north', length: 5, width: 9 }).success).toBe(false)
  })
})

describe('BranchMineProvider', () => {
  const mine = new BranchMineProvider()
  const make = (params: object, origin = at(0, 50, 0)) =>
    asPlan(mine.generate(mine.params.parse({ direction: 'north', ...params }), context(origin)))
  const branch = (p: WorkPlan, id: string) => breaks(p).filter((s) => s.branch === id)

  it('has a branch on both sides every 3 blocks by default', () => {
    const p = make({ length: 10 })

    const ids = new Set(breaks(p).map((s) => s.branch))
    expect(ids).toEqual(
      new Set(['main', 'left-3', 'right-3', 'left-6', 'right-6', 'left-9', 'right-9']),
    )
  })

  it('digs branches perpendicular to the main tunnel, on the right and the left', () => {
    const p = make({ length: 10, branch_length: 4 })

    // Heading north: right is east (+x), left is west (-x). The junction at 3 blocks is z = -3.
    expect(keys(branch(p, 'right-3'))).toEqual([
      '1,50,-3',
      '1,51,-3',
      '2,50,-3',
      '2,51,-3',
      '3,50,-3',
      '3,51,-3',
      '4,50,-3',
      '4,51,-3',
    ])
    expect(keys(branch(p, 'left-3'))).toContain('-4,51,-3')
    expect(branch(p, 'right-3')).toHaveLength(8)
  })

  it('leaves two blocks of rock between neighbouring branches at the default spacing', () => {
    const p = make({ length: 10 })
    const zs = new Set(
      branch(p, 'right-3')
        .concat(branch(p, 'right-6'))
        .map((s) => s.at.z),
    )

    expect([...zs].sort((a, b) => a - b)).toEqual([-6, -3]) // z = -4 and -5 between them stay solid
  })

  it('takes another spacing, only one side, and shorter branches', () => {
    const p = make({ length: 13, spacing: 4, sides: 'left', branch_length: 2 })

    expect(new Set(breaks(p).map((s) => s.branch))).toEqual(
      new Set(['main', 'left-4', 'left-8', 'left-12']),
    )
    expect(branch(p, 'left-4')).toHaveLength(4)
  })

  it('makes each cell need the one before it: the first the junction on the main tunnel, then the previous cell', () => {
    const p = make({ length: 10 })

    const cells = branch(p, 'right-6')
    expect(cells[0]?.needs).toEqual(at(0, 50, -6)) // the junction
    expect(cells[1]?.needs).toEqual(at(1, 50, -6)) // the upper cell needs the lower one
    expect(cells[2]?.needs).toEqual(at(1, 50, -6)) // the next section needs the previous floor cell
    expect(cells.every((c) => c.needs !== undefined)).toBe(true)
  })

  it('makes each section of a tunnel need the one before it', () => {
    const tunnel = new TunnelProvider()
    const p = asPlan(
      tunnel.generate(
        tunnel.params.parse({ direction: 'north', length: 3 }),
        context(at(0, 50, 0)),
      ),
    )

    const b = breaks(p)
    expect(b[0]?.needs).toBeUndefined() // the very first cell is where the bot stands
    expect(b[1]?.needs).toEqual(at(0, 50, 0)) // above it
    expect(b[2]?.needs).toEqual(at(0, 50, 0)) // the next section
  })

  it('digs the main tunnel first, then the branches from the entrance outwards', () => {
    const p = make({ length: 10 })

    const firstBranch = breaks(p).findIndex((s) => s.branch !== 'main')
    expect(
      breaks(p)
        .slice(0, firstBranch)
        .every((s) => s.branch === 'main'),
    ).toBe(true)
    expect(
      breaks(p)
        .slice(firstBranch)
        .every((s) => s.branch !== 'main'),
    ).toBe(true)
    const order = breaks(p)
      .map((s) => s.branch)
      .filter((b, i, all) => all.indexOf(b) === i)
    expect(order).toEqual(['main', 'right-3', 'left-3', 'right-6', 'left-6', 'right-9', 'left-9'])
  })

  it('lights the main tunnel, every junction, and each branch', () => {
    const p = make({ length: 10, branch_length: 8 })

    const spots = keys(lights(p))
    expect(spots).toContain('0,50,-5') // main, every 6
    expect(spots).toContain('0,50,-3') // a junction
    expect(spots).toContain('6,50,-3') // along the right branch
    expect(spots).toContain('-6,50,-3') // along the left branch
    expect(lights(p).every((s) => s.minLight === 7)).toBe(true)
  })

  it('needs at least two blocks between branches, and keeps a plain tunnel free of them', () => {
    expect(mine.params.safeParse({ direction: 'north', length: 10, spacing: 1 }).success).toBe(
      false,
    )
    const plain = new TunnelProvider()
    const p = asPlan(
      plain.generate(plain.params.parse({ direction: 'north', length: 30 }), context(at(0, 50, 0))),
    )
    expect(new Set(breaks(p).map((s) => s.branch))).toEqual(new Set(['main']))
  })
})

describe('StaircaseDownProvider', () => {
  const stairs = new StaircaseDownProvider()
  const make = (params: object) =>
    asPlan(
      stairs.generate(stairs.params.parse({ direction: 'east', ...params }), context(at(0, 60, 0))),
    )

  it('goes one block forward and one down per step, three cells high', () => {
    const p = make({ depth: 3 })

    expect(keys(breaks(p))).toEqual([
      '0,60,0',
      '0,61,0',
      '0,62,0',
      '1,59,0',
      '1,60,0',
      '1,61,0',
      '2,58,0',
      '2,59,0',
      '2,60,0',
    ])
  })

  it('lights it, and checks for caves in front', () => {
    const p = make({ depth: 12 })

    expect(lights(p).map((s) => s.at)).toEqual([at(5, 55, 0), at(11, 49, 0)])
    expect(p.cavityCheck).toBe(true)
    // The ceiling near the entrance is the open sky, so the way up is not checked for caves.
    expect(breaks(p)[0]?.probe?.some((o) => o.y === 1)).toBe(false)
  })
})

describe('ExcavationRegistry', () => {
  const registry = new ExcavationRegistry()
    .register(new PitProvider())
    .register(new TunnelProvider())

  it('finds shapes by name and describes their parameters', () => {
    expect(registry.names()).toEqual(['pit', 'tunnel'])
    expect(registry.get('quarry')).toBeUndefined()
    const [pit] = registry.list()
    const schema = pit?.params as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['width', 'length', 'depth', 'exit']),
    )
    expect(schema.required).toEqual(expect.arrayContaining(['width', 'length', 'depth']))
  })
})
