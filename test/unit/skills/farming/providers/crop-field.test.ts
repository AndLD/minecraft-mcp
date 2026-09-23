import { describe, expect, it } from '@jest/globals'
import { CropFieldProvider } from '../../../../../src/skills/farming/providers/crop-field.js'

const origin = { x: 10, y: 64, z: -5 }

describe('CropFieldProvider', () => {
  const provider = new CropFieldProvider()

  it('defaults the origin to two blocks east of the bot, one below its feet', () => {
    expect(provider.defaultOrigin({ x: 1.2, y: 65, z: 3.9 })).toEqual({ x: 3, y: 64, z: 3 })
  })

  it('reports the crop it plants', () => {
    expect(provider.cropOf({ width: 3, length: 3, crop: 'wheat', fence: true, torches: true })).toBe(
      'wheat',
    )
  })

  it('tills every interior plot except the water channel (planting is a follow-up plant_crops call)', () => {
    const plan = provider.generate(
      { width: 3, length: 3, crop: 'wheat', fence: false, torches: false },
      { origin },
    )
    if ('error' in plan) throw new Error(plan.error)

    const tillSteps = plan.steps.filter((s) => s.kind === 'till')
    const placeSteps = plan.steps.filter((s) => s.kind === 'place')
    const waterSteps = placeSteps.filter((s) => s.block === 'water_bucket')

    expect(tillSteps).toHaveLength(8) // 3x3 minus the one channel cell
    expect(placeSteps).toHaveLength(1) // only the water source; no seeds in this plan
    expect(waterSteps).toEqual([
      { kind: 'place', at: { x: 11, y: 64, z: -5 }, block: 'water_bucket', branch: 'channel' },
    ])
  })

  it('builds a fence ring with one gate and torches when asked', () => {
    const plan = provider.generate(
      { width: 3, length: 3, crop: 'carrots', fence: true, torches: true },
      { origin },
    )
    if ('error' in plan) throw new Error(plan.error)

    const fenceSteps = plan.steps.filter((s) => s.kind === 'place' && s.block === 'oak_fence')
    const gateSteps = plan.steps.filter((s) => s.kind === 'place' && s.block === 'oak_fence_gate')
    const torchSteps = plan.steps.filter((s) => s.kind === 'light')

    expect(fenceSteps).toHaveLength(15) // 16-cell ring minus the gate
    expect(gateSteps).toHaveLength(1)
    expect(gateSteps[0]).toMatchObject({ alignAxis: 'x' })
    expect(torchSteps.length).toBeGreaterThan(0)
  })

  it('skips fence and torches when both are off', () => {
    const plan = provider.generate(
      { width: 3, length: 3, crop: 'potatoes', fence: false, torches: true },
      { origin },
    )
    if ('error' in plan) throw new Error(plan.error)

    expect(plan.steps.some((s) => s.kind === 'place' && s.block === 'oak_fence')).toBe(false)
    expect(plan.steps.some((s) => s.kind === 'light')).toBe(false)
  })

  it('names the plan after the crop and dimensions', () => {
    const plan = provider.generate(
      { width: 4, length: 5, crop: 'beetroots', fence: false, torches: false },
      { origin },
    )
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.name).toBe('beetroots field 4x5')
    expect(plan.standing).toBe('inside')
  })
})
