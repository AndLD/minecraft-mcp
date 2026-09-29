import { describe, expect, it } from '@jest/globals'
import {
  AnimalPenProvider,
  penCapacity,
} from '../../../../../src/skills/farming/providers/animal-pen.js'

const origin = { x: 10, y: 64, z: -5 }

describe('AnimalPenProvider', () => {
  const provider = new AnimalPenProvider()

  it('defaults the origin to two blocks east of the bot, one below its feet', () => {
    expect(provider.defaultOrigin({ x: 1.2, y: 65, z: 3.9 })).toEqual({ x: 3, y: 64, z: 3 })
  })

  it('reports the species it keeps', () => {
    expect(
      provider.speciesOf({ width: 4, length: 4, species: 'cow', water: false, torches: true }),
    ).toBe('cow')
  })

  it('builds a fence ring with one gate and no interior work', () => {
    const plan = provider.generate(
      { width: 4, length: 4, species: 'cow', water: false, torches: false },
      { origin },
    )
    if ('error' in plan) throw new Error(plan.error)

    expect(plan.steps.every((s) => s.kind === 'place')).toBe(true)
    expect(
      plan.steps.filter((s) => s.kind === 'place' && s.block === 'oak_fence_gate'),
    ).toHaveLength(1)
    expect(plan.name).toBe('cow pen 4x4')
    expect(plan.standing).toBe('inside')
  })

  it('places one water source in the middle when asked', () => {
    const plan = provider.generate(
      { width: 5, length: 5, species: 'pig', water: true, torches: false },
      { origin },
    )
    if ('error' in plan) throw new Error(plan.error)

    const water = plan.steps.filter((s) => s.kind === 'place' && s.block === 'water_bucket')
    expect(water).toEqual([
      { kind: 'place', at: { x: 12, y: 64, z: -3 }, block: 'water_bucket', branch: 'water' },
    ])
  })

  it('skips water when not asked', () => {
    const plan = provider.generate(
      { width: 4, length: 4, species: 'cow', water: false, torches: false },
      { origin },
    )
    if ('error' in plan) throw new Error(plan.error)

    expect(plan.steps.some((s) => s.kind === 'place' && s.block === 'water_bucket')).toBe(false)
  })

  it('lights the fence when asked', () => {
    const plan = provider.generate(
      { width: 4, length: 4, species: 'sheep', water: false, torches: true },
      { origin },
    )
    if ('error' in plan) throw new Error(plan.error)

    expect(plan.steps.some((s) => s.kind === 'light')).toBe(true)
  })
})

describe('AnimalPenProvider: the interior', () => {
  const provider = new AnimalPenProvider()
  const params = { width: 4, length: 4, species: 'cow' as const, water: false, torches: false }
  const seen = (cells: Record<string, string>) => (at: { x: number; y: number; z: number }) =>
    cells[`${String(at.x)},${String(at.y)},${String(at.z)}`] ?? 'air'
  const breaks = (plan: ReturnType<typeof provider.generate>) => {
    if ('error' in plan) throw new Error(plan.error)
    return plan.steps.flatMap((step) => (step.kind === 'break' ? [step.at] : []))
  }

  it('breaks natural blocks at fence level and one above, inside the footprint only', () => {
    const plan = provider.generate(params, {
      origin,
      blockAt: seen({
        '10,65,-5': 'grass_block', // fence level
        '12,65,-3': 'dirt',
        '12,66,-3': 'stone', // headroom
        '9,65,-5': 'grass_block', // outside the footprint (the fence's own cell)
        '11,64,-4': 'grass_block', // the ground itself: not touched
      }),
    })

    expect(breaks(plan)).toEqual([
      { x: 10, y: 65, z: -5 },
      { x: 12, y: 65, z: -3 },
      { x: 12, y: 66, z: -3 },
    ])
  })

  it('does not break air, grass, or water, which need no clearing', () => {
    const plan = provider.generate(params, {
      origin,
      blockAt: seen({ '10,65,-5': 'short_grass', '11,65,-5': 'water', '12,65,-5': 'air' }),
    })

    expect(breaks(plan)).toEqual([])
  })

  it('clears flowers and other plants that are not replaceable', () => {
    const plan = provider.generate(params, { origin, blockAt: seen({ '10,65,-5': 'dandelion' }) })

    expect(breaks(plan)).toEqual([{ x: 10, y: 65, z: -5 }])
  })

  it('leaves anything else, warns about it, and does not break it', () => {
    const plan = provider.generate(params, {
      origin,
      blockAt: seen({ '10,65,-5': 'chest', '11,65,-5': 'oak_planks', '12,65,-5': 'oak_log' }),
    })
    if ('error' in plan) throw new Error(plan.error)

    expect(breaks(plan)).toEqual([])
    expect(plan.warnings?.[0]).toContain('3 cell(s)')
    expect(plan.warnings?.[0]).toContain('chest')
    expect(plan.warnings?.[0]).toContain('oak_planks')
  })

  it('leaves out cells that are not loaded', () => {
    const plan = provider.generate(params, { origin, blockAt: () => undefined })

    expect(breaks(plan)).toEqual([])
  })

  it('puts the clearing before the fence, so the interior is clear before the pen is finished', () => {
    const plan = provider.generate(params, { origin, blockAt: seen({ '10,65,-5': 'grass_block' }) })
    if ('error' in plan) throw new Error(plan.error)

    expect(plan.steps[0]).toMatchObject({ kind: 'break' })
    expect(plan.steps[1]).toMatchObject({ kind: 'place', block: 'oak_fence' })
  })

  it('works without a view of the world, as before', () => {
    const plan = provider.generate(params, { origin })

    expect(breaks(plan)).toEqual([])
  })
})

describe('penCapacity', () => {
  it('is one animal per block of the footprint', () => {
    expect(penCapacity(4, 4)).toBe(16)
    expect(penCapacity(3, 5)).toBe(15)
  })
})
