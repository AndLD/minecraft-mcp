import { describe, expect, it } from '@jest/globals'
import { classifyCrop, cropFor, CROP_NAMES } from '../../../../src/skills/farming/crop-table.js'

describe('classifyCrop', () => {
  it.each([
    ['wheat', 7],
    ['carrots', 7],
    ['potatoes', 7],
    ['beetroots', 3],
  ] as const)('classifies %s with maxAge %d', (name, maxAge) => {
    expect(classifyCrop(name)?.maxAge).toBe(maxAge)
  })

  it('is undefined for anything else', () => {
    expect(classifyCrop('stone')).toBeUndefined()
    expect(classifyCrop('wheat_seeds')).toBeUndefined()
  })
})

describe('cropFor', () => {
  it('resolves by the crop name itself', () => {
    expect(cropFor('wheat')).toEqual({ block: 'wheat', spec: { seed: 'wheat_seeds', maxAge: 7 } })
  })

  it('resolves by the seed item name', () => {
    expect(cropFor('carrot')).toEqual({ block: 'carrots', spec: { seed: 'carrot', maxAge: 7 } })
    expect(cropFor('beetroot_seeds')).toEqual({
      block: 'beetroots',
      spec: { seed: 'beetroot_seeds', maxAge: 3 },
    })
  })

  it('is undefined for anything else', () => {
    expect(cropFor('diamond')).toBeUndefined()
  })

  it('covers every crop name', () => {
    for (const name of CROP_NAMES) expect(cropFor(name)).toBeDefined()
  })
})
