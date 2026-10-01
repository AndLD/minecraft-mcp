import { describe, expect, it } from '@jest/globals'
import type { Blueprint } from '../../../../src/skills/building/blueprint.types.js'
import { planFor } from '../../../../src/skills/building/blueprint-plan.js'
import { CustomBlueprintProvider } from '../../../../src/skills/building/providers/custom-provider.js'
import {
  ShelterProvider,
  SmallHouseProvider,
} from '../../../../src/skills/building/providers/house-providers.js'

const has = (b: Blueprint, dx: number, dy: number, dz: number): string | undefined =>
  b.placements.find((p) => p.dx === dx && p.dy === dy && p.dz === dz)?.block

const house = (patch: Record<string, unknown> = {}) => {
  const provider = new SmallHouseProvider()
  return provider.generate(provider.params.parse({ width: 7, depth: 6, ...patch }))
}

describe('SmallHouseProvider', () => {
  it('has a floor, walls, a flat roof, and a doorway', () => {
    const blueprint = house()

    expect(has(blueprint, 0, 0, 0)).toBe('oak_planks') // floor
    expect(has(blueprint, 6, 3, 5)).toBe('oak_planks') // wall corner, top layer
    expect(has(blueprint, 3, 4, 2)).toBe('oak_planks') // roof
    expect(has(blueprint, 3, 1, 2)).toBeUndefined() // inside
    expect(blueprint.size).toEqual({ width: 7, height: 5, depth: 6 })
    // The doorway is at x = 3 in the north wall, two blocks high, and the door goes in it.
    expect(has(blueprint, 3, 2, 0)).toBeUndefined()
    expect(has(blueprint, 3, 3, 0)).toBe('oak_planks') // the wall above the doorway
    expect(has(blueprint, 3, 1, 0)).toBe('oak_door')
  })

  it('lists the door last, aligned along z (it lies in a wall that runs along x)', () => {
    const blueprint = house()

    const last = blueprint.placements.at(-1)
    expect(last).toEqual({ dx: 3, dy: 1, dz: 0, block: 'oak_door', alignAxis: 'z' })
    expect(blueprint.placements.filter((p) => p.block === 'oak_door')).toHaveLength(1)
  })

  it('uses another door, floor, and roof material when asked', () => {
    const blueprint = house({
      door: 'spruce_door',
      floor_block: 'stone',
      roof_block: 'cobblestone',
    })

    expect(has(blueprint, 3, 1, 0)).toBe('spruce_door')
    expect(has(blueprint, 1, 0, 1)).toBe('stone')
    expect(has(blueprint, 1, 4, 1)).toBe('cobblestone')
  })

  it('puts windows at eye level in three walls, when asked', () => {
    const blueprint = house({ windows: true })

    expect(has(blueprint, 0, 2, 3)).toBe('glass_pane')
    expect(has(blueprint, 6, 2, 3)).toBe('glass_pane')
    expect(has(blueprint, 3, 2, 5)).toBe('glass_pane')
    expect(blueprint.placements.filter((p) => p.block === 'glass_pane')).toHaveLength(3)
    expect(has(house(), 0, 2, 3)).toBe('oak_planks') // none by default
  })

  it('has torches inside by default, and none when not lit', () => {
    expect(house().lights.length).toBeGreaterThan(0)
    expect(house().lights.every((l) => l.dy === 1 && l.dx >= 1 && l.dz >= 1)).toBe(true)
    expect(house({ lit: false }).lights).toEqual([])
  })

  it('builds walls of any allowed height, and enforces sizes', () => {
    expect(house({ height: 5 }).size.height).toBe(7)
    const provider = new SmallHouseProvider()
    expect(provider.params.safeParse({ width: 2, depth: 6 }).success).toBe(false)
    expect(provider.params.safeParse({ width: 30, depth: 6 }).success).toBe(false)
    expect(provider.params.safeParse({ width: 6, depth: 6, height: 2 }).success).toBe(false)
  })

  it('never lists a cell twice', () => {
    const cells = house({ windows: true }).placements.map(
      (p) => `${String(p.dx)},${String(p.dy)},${String(p.dz)}`,
    )

    expect(new Set(cells).size).toBe(cells.length)
  })

  it('turns into a plan whose door step carries the alignment', () => {
    const plan = planFor(house(), { x: 10, y: 64, z: 10 })

    expect(plan.steps.at(-2)).toMatchObject({
      kind: 'place',
      block: 'oak_door',
      alignAxis: 'z',
      at: { x: 13, y: 65, z: 10 },
    })
    expect(plan.standing).toBeUndefined()
  })
})

describe('ShelterProvider', () => {
  const blueprint = new ShelterProvider().generate({ block: 'cobblestone' })

  it('is a sealed 3x4 shell, two walls high with a roof, and no floor', () => {
    expect(blueprint.placements).toHaveLength(10 * 2 + 12)
    expect(blueprint.size).toEqual({ width: 3, height: 3, depth: 4 })
    expect(has(blueprint, 0, 0, 0)).toBe('cobblestone')
    expect(has(blueprint, 1, 2, 1)).toBe('cobblestone') // roof over the bot
    expect(blueprint.placements.some((p) => p.dy < 0)).toBe(false)
    expect(
      blueprint.placements.every((p) => p.dy !== 0 || p.dx !== 1 || (p.dz !== 1 && p.dz !== 2)),
    ).toBe(true) // no floor
  })

  it('leaves the two cells the bot needs, above each other', () => {
    for (const dy of [0, 1]) {
      expect(has(blueprint, 1, dy, 1)).toBeUndefined()
      expect(has(blueprint, 1, dy, 2)).toBeUndefined()
    }
  })

  it('is built around the bot, from inside', () => {
    expect(blueprint.anchor).toEqual({ dx: 1, dy: 0, dz: 1 })
    expect(blueprint.standing).toBe('inside')
    expect(planFor(blueprint, { x: 0, y: 64, z: 0 }).standing).toBe('inside')
  })
})

describe('CustomBlueprintProvider', () => {
  const provider = new CustomBlueprintProvider()
  const generate = (params: unknown) => provider.generate(provider.params.parse(params))

  it('reads layers, rows, and a legend into placements', () => {
    const blueprint = generate({
      name: 'hut',
      layers: [
        ['###', '#.#', '###'],
        ['#T#', '...', '###'],
      ],
      legend: { '#': 'stone_bricks', T: 'torch' },
    })

    expect(blueprint.name).toBe('hut')
    expect(blueprint.size).toEqual({ width: 3, height: 2, depth: 3 })
    expect(has(blueprint, 0, 0, 0)).toBe('stone_bricks')
    expect(has(blueprint, 1, 0, 1)).toBeUndefined()
    expect(has(blueprint, 1, 1, 0)).toBe('torch')
    expect(blueprint.placements).toHaveLength(8 + 6)
  })

  it('treats spaces and dots as empty', () => {
    expect(
      generate({ layers: [['# #', '.#.']], legend: { '#': 'stone' } }).placements,
    ).toHaveLength(3)
  })

  it('places doors last and aligns them with their wall', () => {
    const inXWall = generate({
      layers: [['#D#'], ['#.#']],
      legend: { '#': 'stone', D: 'oak_door' },
    })
    const inZWall = generate({ layers: [['#', 'D', '#']], legend: { '#': 'stone', D: 'oak_door' } })

    expect(inXWall.placements.at(-1)).toMatchObject({ block: 'oak_door', alignAxis: 'z' })
    expect(inZWall.placements.at(-1)).toMatchObject({ block: 'oak_door', alignAxis: 'x' })
    expect(inXWall.placements.filter((p) => p.block === 'oak_door')).toHaveLength(1)
  })

  it('reports a character the legend does not define, and too many blocks', () => {
    const undefinedChar = provider.params.safeParse({ layers: [['#X']], legend: { '#': 'stone' } })
    expect(undefinedChar.success).toBe(false)
    expect(!undefinedChar.success && undefinedChar.error.issues[0]?.message).toContain('"X"')

    const layer = Array.from({ length: 32 }, () => '#'.repeat(32))
    const huge = provider.params.safeParse({
      layers: [layer, layer, layer, layer, layer],
      legend: { '#': 'stone' },
    })
    expect(huge.success).toBe(false)
    expect(!huge.success && huge.error.issues[0]?.message).toContain('limit is 4000')
  })

  it('rejects empty designs, oversized sides, and a legend key longer than one character', () => {
    expect(provider.params.safeParse({ layers: [], legend: {} }).success).toBe(false)
    expect(
      provider.params.safeParse({ layers: [['#'.repeat(40)]], legend: { '#': 'stone' } }).success,
    ).toBe(false)
    expect(provider.params.safeParse({ layers: [['#']], legend: { '##': 'stone' } }).success).toBe(
      false,
    )
  })
})
