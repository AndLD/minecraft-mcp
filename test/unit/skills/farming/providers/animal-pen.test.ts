import { describe, expect, it } from '@jest/globals'
import { AnimalPenProvider, penCapacity } from '../../../../../src/skills/farming/providers/animal-pen.js'

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
    expect(plan.steps.filter((s) => s.kind === 'place' && s.block === 'oak_fence_gate')).toHaveLength(1)
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

describe('penCapacity', () => {
  it('is one animal per block of the footprint', () => {
    expect(penCapacity(4, 4)).toBe(16)
    expect(penCapacity(3, 5)).toBe(15)
  })
})
