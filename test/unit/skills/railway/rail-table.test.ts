import { describe, expect, it } from '@jest/globals'
import { isRailName, rawMaterialsFor } from '../../../../src/skills/railway/rail-table.js'

describe('rawMaterialsFor', () => {
  it('counts whole crafts: 20 rails take two crafts of six iron ingots and a stick each', () => {
    expect(rawMaterialsFor([{ name: 'rail', count: 20 }])).toEqual([
      { name: 'iron_ingot', count: 12 },
      { name: 'stick', count: 2 },
    ])
  })

  it('adds up what several items need of the same material', () => {
    const raw = rawMaterialsFor([
      { name: 'rail', count: 16 },
      { name: 'powered_rail', count: 7 },
      { name: 'redstone_torch', count: 3 },
      { name: 'minecart', count: 1 },
    ])

    expect(raw).toEqual([
      { name: 'gold_ingot', count: 12 }, // 7 powered rails: two crafts of six
      { name: 'iron_ingot', count: 11 }, // one craft of rails and one minecart
      { name: 'redstone', count: 5 }, // two crafts of powered rails, three torches
      { name: 'stick', count: 6 }, // 1 + 2 + 3
    ])
  })

  it('leaves out what is not crafted here, and what is not missing', () => {
    expect(
      rawMaterialsFor([
        { name: 'cobblestone', count: 30 },
        { name: 'rail', count: 0 },
        { name: 'powered_rail', count: -2 },
      ]),
    ).toEqual([])
  })
})

describe('isRailName', () => {
  it('knows the two kinds it lays', () => {
    expect(isRailName('rail')).toBe(true)
    expect(isRailName('powered_rail')).toBe(true)
    expect(isRailName('detector_rail')).toBe(false)
    expect(isRailName(undefined)).toBe(false)
  })
})
