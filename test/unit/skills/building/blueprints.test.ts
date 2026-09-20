import { describe, expect, it } from '@jest/globals'
import { BlueprintRegistry } from '../../../../src/skills/building/blueprint-registry.js'
import { boundsOf, planFor } from '../../../../src/skills/building/blueprint-plan.js'
import {
  BoxProvider,
  FloorProvider,
  SingleBlockProvider,
  SolidProvider,
  WallsProvider,
} from '../../../../src/skills/building/providers/basic-providers.js'
import { fill, outline } from '../../../../src/skills/building/providers/dimensions.js'

const counts = (blueprint: {
  placements: readonly { block: string }[]
}): Record<string, number> => {
  const totals: Record<string, number> = {}
  for (const p of blueprint.placements) totals[p.block] = (totals[p.block] ?? 0) + 1
  return totals
}
const unique = (blueprint: {
  placements: readonly { dx: number; dy: number; dz: number }[]
}): number =>
  new Set(blueprint.placements.map((p) => `${String(p.dx)},${String(p.dy)},${String(p.dz)}`)).size

describe('outline and fill', () => {
  it('outline lists each edge cell once', () => {
    expect(outline(4, 3, 0, 'x')).toHaveLength(10)
    expect(new Set(outline(4, 3, 0, 'x').map((c) => `${String(c.dx)},${String(c.dz)}`)).size).toBe(
      10,
    )
  })

  it('handles thin rectangles without repeating cells', () => {
    expect(outline(1, 1, 0, 'x')).toHaveLength(1)
    expect(outline(5, 1, 0, 'x')).toHaveLength(5)
    expect(outline(1, 5, 0, 'x')).toHaveLength(5)
    expect(outline(2, 2, 0, 'x')).toHaveLength(4)
  })

  it('fill covers the whole rectangle', () => {
    expect(fill(3, 4, 2, 'x')).toHaveLength(12)
    expect(fill(3, 4, 2, 'x').every((c) => c.dy === 2)).toBe(true)
  })
})

describe('the basic blueprints', () => {
  it('a floor is one filled layer', () => {
    const blueprint = new FloorProvider().generate({ width: 5, depth: 3, block: 'stone' })

    expect(blueprint.placements).toHaveLength(15)
    expect(blueprint.size).toEqual({ width: 5, height: 1, depth: 3 })
    expect(new Set(blueprint.placements.map((p) => p.dy))).toEqual(new Set([0]))
  })

  it('walls are a hollow ring, layer by layer from the bottom', () => {
    const blueprint = new WallsProvider().generate({
      width: 5,
      depth: 4,
      height: 3,
      block: 'stone',
    })

    expect(blueprint.placements).toHaveLength(14 * 3)
    expect(unique(blueprint)).toBe(14 * 3)
    const layers = blueprint.placements.map((p) => p.dy)
    expect(layers).toEqual([...layers].sort((a, b) => a - b))
    expect(blueprint.placements.some((p) => p.dx === 2 && p.dz === 1)).toBe(false) // the inside is empty
  })

  it('a solid is completely filled', () => {
    const blueprint = new SolidProvider().generate({
      width: 2,
      depth: 3,
      height: 4,
      block: 'stone',
    })

    expect(blueprint.placements).toHaveLength(24)
    expect(unique(blueprint)).toBe(24)
  })

  it('a single block is one placement', () => {
    expect(new SingleBlockProvider().generate({ block: 'torch' }).placements).toEqual([
      { dx: 0, dy: 0, dz: 0, block: 'torch' },
    ])
  })

  it('a box has a floor, walls above it, and a roof', () => {
    const blueprint = new BoxProvider().generate({
      width: 4,
      depth: 4,
      height: 2,
      wall_block: 'stone_bricks',
      floor_block: 'oak_planks',
      roof_block: 'cobblestone',
      floor: true,
      roof: true,
      doorway: false,
      lit: false,
    })

    expect(counts(blueprint)).toEqual({ oak_planks: 16, stone_bricks: 24, cobblestone: 16 })
    expect(blueprint.size).toEqual({ width: 4, height: 4, depth: 4 })
    expect(unique(blueprint)).toBe(56)
    expect(blueprint.lights).toEqual([])
  })

  it('a box can leave out the floor and the roof, and defaults to the wall block', () => {
    const blueprint = new BoxProvider().generate({
      width: 3,
      depth: 3,
      height: 2,
      wall_block: 'stone',
      floor: false,
      roof: false,
      doorway: false,
      lit: false,
    })

    expect(counts(blueprint)).toEqual({ stone: 16 })
    expect(blueprint.size.height).toBe(2)
    expect(Math.min(...blueprint.placements.map((p) => p.dy))).toBe(0)
  })

  it('a box has a doorway two blocks high in the wall at z = 0, unless it is sealed', () => {
    const params = {
      width: 5,
      depth: 5,
      height: 3,
      wall_block: 'stone',
      floor: true,
      roof: true,
      lit: false,
    }
    const open = new BoxProvider().generate({ ...params, doorway: true })
    const sealed = new BoxProvider().generate({ ...params, doorway: false })

    const has = (b: typeof open, dx: number, dy: number, dz: number): boolean =>
      b.placements.some((p) => p.dx === dx && p.dy === dy && p.dz === dz)
    expect(sealed.placements.length - open.placements.length).toBe(2)
    expect(has(sealed, 2, 1, 0) && has(sealed, 2, 2, 0)).toBe(true)
    expect(has(open, 2, 1, 0) || has(open, 2, 2, 0)).toBe(false) // the gap, above the floor
    expect(has(open, 2, 0, 0)).toBe(true) // the floor stays
    expect(has(open, 2, 3, 0)).toBe(true) // the wall above the doorway stays
  })

  it('a lit box gets torches inside, one for every 5x5 blocks', () => {
    const blueprint = new BoxProvider().generate({
      width: 12,
      depth: 6,
      height: 3,
      wall_block: 'stone',
      floor: true,
      roof: true,
      doorway: true,
      lit: true,
    })

    expect(blueprint.lights.length).toBe(2)
    expect(
      blueprint.lights.every(
        (l) => l.dy === 1 && l.dx >= 1 && l.dx <= 10 && l.dz >= 1 && l.dz <= 4,
      ),
    ).toBe(true)
  })

  it('generates the same blueprint every time', () => {
    const params = {
      width: 6,
      depth: 5,
      height: 3,
      wall_block: 'stone',
      floor: true,
      roof: true,
      doorway: true,
      lit: true,
    }

    expect(new BoxProvider().generate(params)).toEqual(new BoxProvider().generate(params))
  })
})

describe('parameters', () => {
  it('apply defaults and enforce limits', () => {
    const box = new BoxProvider()

    expect(box.params.safeParse({ width: 4, depth: 4, height: 3 }).data).toMatchObject({
      wall_block: 'cobblestone',
      floor: true,
      roof: true,
      lit: false,
    })
    expect(box.params.safeParse({ width: 0, depth: 4, height: 3 }).success).toBe(false)
    expect(box.params.safeParse({ width: 40, depth: 4, height: 3 }).success).toBe(false)
    expect(box.params.safeParse({ width: 2.5, depth: 4, height: 3 }).success).toBe(false)
    expect(box.params.safeParse({ depth: 4, height: 3 }).success).toBe(false)
  })
})

describe('planFor', () => {
  it('moves the blueprint to the origin and adds the lighting steps', () => {
    const blueprint = new BoxProvider().generate({
      width: 7,
      depth: 7,
      height: 2,
      wall_block: 'stone',
      floor: true,
      roof: true,
      doorway: true,
      lit: true,
    })

    const plan = planFor(blueprint, { x: 100, y: 64, z: -20 })

    expect(plan.name).toBe('box 7x7x2')
    expect(plan.steps[0]).toEqual({ kind: 'place', at: { x: 100, y: 64, z: -20 }, block: 'stone' })
    const lights = plan.steps.filter((s) => s.kind === 'light')
    expect(lights.length).toBe(blueprint.lights.length)
    expect(lights[0]).toMatchObject({ at: { x: 101, y: 65, z: -19 }, minLight: 8 })
    expect(plan.steps.length).toBe(blueprint.placements.length + lights.length)
  })

  it('bounds are the corners of the volume', () => {
    const blueprint = new WallsProvider().generate({
      width: 5,
      depth: 4,
      height: 3,
      block: 'stone',
    })

    expect(boundsOf(blueprint, { x: 10, y: 64, z: 10 })).toEqual({
      from: { x: 10, y: 64, z: 10 },
      to: { x: 14, y: 66, z: 13 },
    })
  })
})

describe('BlueprintRegistry', () => {
  const registry = new BlueprintRegistry()
    .register(new WallsProvider())
    .register(new BoxProvider())
    .register(new FloorProvider())

  it('finds providers by name and lists the names sorted', () => {
    expect(registry.get('box')?.name).toBe('box')
    expect(registry.get('castle')).toBeUndefined()
    expect(registry.names()).toEqual(['box', 'floor', 'walls'])
  })

  it('describes each blueprint with a JSON schema of its parameters', () => {
    const [box] = registry.list()

    expect(box).toMatchObject({ name: 'box' })
    const schema = box?.params as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['width', 'depth', 'height', 'wall_block', 'lit']),
    )
    expect(schema.required).toEqual(expect.arrayContaining(['width', 'depth', 'height']))
    expect(box?.description).toContain('doorway')
  })
})
