import { describe, expect, it } from '@jest/globals'
import {
  CropFieldProvider,
  waterCentres,
  waterPlots,
  WATER_LAYOUTS,
} from '../../../../../src/skills/farming/providers/crop-field.js'

const origin = { x: 10, y: 64, z: -5 }

describe('CropFieldProvider', () => {
  const provider = new CropFieldProvider()

  it('defaults the origin to two blocks east of the bot, one below its feet', () => {
    expect(provider.defaultOrigin({ x: 1.2, y: 65, z: 3.9 })).toEqual({ x: 3, y: 64, z: 3 })
  })

  it('reports the crop it plants', () => {
    expect(
      provider.cropOf({
        width: 3,
        length: 3,
        crop: 'wheat',
        fence: true,
        torches: true,
        water: 'trench',
      }),
    ).toBe('wheat')
  })

  it('tills every plot except the water trench (planting is a follow-up plant_crops call)', () => {
    const plan = provider.generate(
      { width: 3, length: 3, crop: 'wheat', fence: false, torches: false, water: 'trench' },
      { origin },
    )
    if ('error' in plan) throw new Error(plan.error)

    const tillSteps = plan.steps.filter((s) => s.kind === 'till')
    const waterSteps = plan.steps.filter((s) => s.kind === 'place' && s.block === 'water_bucket')

    expect(tillSteps).toHaveLength(6) // 3x3 minus the trench down the middle column
    expect(waterSteps.map((s) => s.at)).toEqual([
      { x: 11, y: 64, z: -5 },
      { x: 11, y: 64, z: -4 },
      { x: 11, y: 64, z: -3 },
    ])
    expect(plan.steps).toHaveLength(9) // no seeds in this plan
  })

  it('places the water before tilling anything, so no farmland dries out and reverts to dirt while waiting for it', () => {
    const plan = provider.generate(
      { width: 7, length: 7, crop: 'wheat', fence: true, torches: false, water: 'spots' },
      { origin },
    )
    if ('error' in plan) throw new Error(plan.error)

    const lastWater = plan.steps.findLastIndex(
      (s) => s.kind === 'place' && s.block === 'water_bucket',
    )
    const firstTill = plan.steps.findIndex((s) => s.kind === 'till')
    expect(lastWater).toBeGreaterThanOrEqual(0)
    expect(lastWater).toBeLessThan(firstTill)
  })

  it('uses a trench by default', () => {
    const parsed = provider.params.parse({ width: 5, length: 5, crop: 'wheat' })

    expect(parsed.water).toBe('trench')
  })

  it('puts one water block at the centre of a 7x7 field with spots', () => {
    const plan = provider.generate(
      { width: 7, length: 7, crop: 'wheat', fence: false, torches: false, water: 'spots' },
      { origin },
    )
    if ('error' in plan) throw new Error(plan.error)

    const water = plan.steps.filter((s) => s.kind === 'place' && s.block === 'water_bucket')
    expect(water.map((s) => s.at)).toEqual([{ x: 13, y: 64, z: -2 }])
    expect(plan.steps.filter((s) => s.kind === 'till')).toHaveLength(48)
  })

  it('lays a trench of the whole length down the middle of a long field', () => {
    const plan = provider.generate(
      { width: 5, length: 32, crop: 'wheat', fence: false, torches: false, water: 'trench' },
      { origin },
    )
    if ('error' in plan) throw new Error(plan.error)

    const water = plan.steps.filter((s) => s.kind === 'place' && s.block === 'water_bucket')
    expect(water).toHaveLength(32)
    expect(new Set(water.map((s) => s.at.x))).toEqual(new Set([12]))
  })

  describe('where the water goes', () => {
    const cells = (width: number, length: number, layout: (typeof WATER_LAYOUTS)[number]) =>
      waterPlots(width, length, layout)

    const widths = Array.from({ length: 16 }, (_, k) => k + 3) // 3 to 18
    const lengths = [3, 4, 7, 9, 10, 17, 18, 19, 27, 32]

    it.each(WATER_LAYOUTS)(
      '%s: every plot of every size is within four blocks of water',
      (layout) => {
        for (const width of widths)
          for (const length of lengths) {
            const water = cells(width, length, layout)
            for (let i = 0; i < width; i += 1)
              for (let j = 0; j < length; j += 1)
                expect(
                  water.some(({ i: wi, j: wj }) => Math.abs(wi - i) <= 4 && Math.abs(wj - j) <= 4),
                ).toBe(true)
          }
      },
    )

    it.each(WATER_LAYOUTS)('%s: never puts water on the edge of the field', (layout) => {
      for (const width of widths)
        for (const length of lengths)
          for (const { i, j } of cells(width, length, layout)) {
            expect(i).toBeGreaterThan(0)
            expect(i).toBeLessThan(width - 1)
            if (layout === 'spots') {
              expect(j).toBeGreaterThan(0)
              expect(j).toBeLessThan(length - 1)
            }
          }
    })

    it('cuts a side into equal parts of at most nine and centres water in each', () => {
      expect(waterCentres(3)).toEqual([1])
      expect(waterCentres(7)).toEqual([3])
      expect(waterCentres(9)).toEqual([4])
      expect(waterCentres(10)).toEqual([2, 7]) // two parts of 5, not 9 and 1
      expect(waterCentres(18)).toEqual([4, 13])
      expect(waterCentres(19)).toEqual([2, 8, 15])
    })

    it('spots: one block per 9x9 part, so the count follows the size', () => {
      expect(cells(9, 9, 'spots')).toHaveLength(1)
      expect(cells(9, 10, 'spots')).toHaveLength(2)
      expect(cells(18, 18, 'spots')).toHaveLength(4)
      expect(cells(7, 32, 'spots')).toHaveLength(4)
    })

    it('trench: one line per part of the width, over the whole length', () => {
      expect(cells(9, 32, 'trench')).toHaveLength(32)
      expect(cells(10, 32, 'trench')).toHaveLength(64)
    })
  })

  it('accepts widths from 3 up to 18 and lengths up to 32, and no more', () => {
    const ok = (width: number, length: number) =>
      provider.params.safeParse({ width, length, crop: 'wheat' }).success

    expect(ok(3, 3)).toBe(true)
    expect(ok(18, 32)).toBe(true)
    expect(ok(19, 5)).toBe(false)
    expect(ok(5, 33)).toBe(false)
    expect(ok(2, 5)).toBe(false)
  })

  it('builds a fence ring with one gate and torches when asked', () => {
    const plan = provider.generate(
      { width: 3, length: 3, crop: 'carrots', fence: true, torches: true, water: 'trench' },
      { origin },
    )
    if ('error' in plan) throw new Error(plan.error)

    const fenceSteps = plan.steps.filter((s) => s.kind === 'place' && s.block === 'oak_fence')
    const gateSteps = plan.steps.filter((s) => s.kind === 'place' && s.block === 'oak_fence_gate')
    const torchSteps = plan.steps.filter((s) => s.kind === 'light')

    expect(fenceSteps).toHaveLength(15) // 16-cell ring minus the gate
    expect(gateSteps).toHaveLength(1)
    // The gate is in the south side, which runs along x: the bot places it standing in line along z.
    expect(gateSteps[0]).toMatchObject({ alignAxis: 'z' })
    expect(torchSteps.length).toBeGreaterThan(0)
  })

  it('skips fence and torches when both are off', () => {
    const plan = provider.generate(
      { width: 3, length: 3, crop: 'potatoes', fence: false, torches: true, water: 'trench' },
      { origin },
    )
    if ('error' in plan) throw new Error(plan.error)

    expect(plan.steps.some((s) => s.kind === 'place' && s.block === 'oak_fence')).toBe(false)
    expect(plan.steps.some((s) => s.kind === 'light')).toBe(false)
  })

  it('names the plan after the crop and dimensions', () => {
    const plan = provider.generate(
      { width: 4, length: 5, crop: 'beetroots', fence: false, torches: false, water: 'trench' },
      { origin },
    )
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.name).toBe('beetroots field 4x5')
    expect(plan.standing).toBe('inside')
  })
})
