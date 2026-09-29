import { describe, expect, it } from '@jest/globals'
import {
  classifyCrop,
  cropFor,
  cropNameOfBlock,
  CROP_NAMES,
  stemCropOfFruit,
} from '../../../../src/skills/farming/crop-table.js'

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
    expect(cropFor('wheat')).toEqual({
      block: 'wheat',
      spec: { seed: 'wheat_seeds', maxAge: 7, kind: 'plain' },
    })
  })

  it('resolves by the seed item name', () => {
    expect(cropFor('carrot')).toEqual({
      block: 'carrots',
      spec: { seed: 'carrot', maxAge: 7, kind: 'plain' },
    })
    expect(cropFor('beetroot_seeds')).toEqual({
      block: 'beetroots',
      spec: { seed: 'beetroot_seeds', maxAge: 3, kind: 'plain' },
    })
  })

  it('is undefined for anything else', () => {
    expect(cropFor('diamond')).toBeUndefined()
  })

  it('covers every crop name', () => {
    for (const name of CROP_NAMES) expect(cropFor(name)).toBeDefined()
  })
})

describe('stem crops (pumpkin)', () => {
  it('knows the stem and its fruit', () => {
    expect(cropFor('pumpkin')).toEqual({
      block: 'pumpkin',
      spec: {
        seed: 'pumpkin_seeds',
        maxAge: 7,
        kind: 'stem',
        stem: 'pumpkin_stem',
        fruit: 'pumpkin',
      },
    })
    expect(cropFor('pumpkin_seeds')?.block).toBe('pumpkin')
  })

  it('classifies the stem, also once it has grown a fruit, as a stem crop', () => {
    expect(classifyCrop('pumpkin_stem')?.kind).toBe('stem')
    expect(classifyCrop('attached_pumpkin_stem')?.kind).toBe('stem')
  })

  it('does not classify the fruit block itself as a crop to harvest in place', () => {
    expect(classifyCrop('pumpkin')).toBeUndefined()
  })

  it('finds the stem crop of a fruit block', () => {
    expect(stemCropOfFruit('pumpkin')?.stem).toBe('pumpkin_stem')
    expect(stemCropOfFruit('wheat')).toBeUndefined()
    expect(stemCropOfFruit('carved_pumpkin')).toBeUndefined()
  })

  it('names a crop by the block seen in the field', () => {
    expect(cropNameOfBlock('pumpkin_stem')).toBe('pumpkin')
    expect(cropNameOfBlock('wheat')).toBe('wheat')
    expect(cropNameOfBlock('stone')).toBeUndefined()
  })
})
