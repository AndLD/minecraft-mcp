import { describe, expect, it } from '@jest/globals'
import { chooseFuel } from '../../../../src/skills/smelting/fuel.js'

const inventory = (items: Record<string, number>): Map<string, number> =>
  new Map(Object.entries(items))

describe('chooseFuel', () => {
  it('takes just enough of the first default fuel: charcoal before coal', () => {
    const choice = chooseFuel({ inventory: inventory({ coal: 5, charcoal: 5 }), toSmelt: 10 })

    expect(choice).toEqual({ item: 'charcoal', amount: 2, capacity: 16 })
  })

  it('prefers a fuel that covers everything over a preferred one that does not', () => {
    const choice = chooseFuel({
      inventory: inventory({ charcoal: 1, coal: 3 }),
      toSmelt: 16,
    })

    expect(choice).toEqual({ item: 'coal', amount: 2, capacity: 16 })
  })

  it('burns cheap wood only after coal, and sticks before planks before logs', () => {
    expect(
      chooseFuel({ inventory: inventory({ oak_log: 9, oak_planks: 9, stick: 9 }), toSmelt: 4 })
        ?.item,
    ).toBe('stick')
    expect(
      chooseFuel({ inventory: inventory({ oak_log: 9, birch_planks: 9 }), toSmelt: 3 })?.item,
    ).toBe('birch_planks')
    expect(chooseFuel({ inventory: inventory({ oak_log: 9 }), toSmelt: 3 })).toEqual({
      item: 'oak_log',
      amount: 2,
      capacity: 3,
    })
  })

  it('never burns valuable fuel unless it is named', () => {
    const items = inventory({ coal_block: 2, blaze_rod: 3, lava_bucket: 1 })

    expect(chooseFuel({ inventory: items, toSmelt: 5 })).toBeUndefined()
    expect(chooseFuel({ inventory: items, toSmelt: 100, preferred: 'coal_block' })).toEqual({
      item: 'coal_block',
      amount: 2,
      capacity: 160,
    })
  })

  it('takes the fuel that smelts the most when none covers the job', () => {
    const choice = chooseFuel({
      inventory: inventory({ stick: 6, coal: 1, oak_planks: 2 }),
      toSmelt: 64,
    })

    expect(choice).toEqual({ item: 'coal', amount: 1, capacity: 8 })
  })

  it('does not burn what is being smelted', () => {
    const items = inventory({ oak_log: 4 })

    expect(
      chooseFuel({ inventory: items, toSmelt: 4, reserved: { name: 'oak_log', count: 4 } }),
    ).toBeUndefined()
    expect(
      chooseFuel({ inventory: items, toSmelt: 1, reserved: { name: 'oak_log', count: 3 } }),
    ).toEqual({ item: 'oak_log', amount: 1, capacity: 1 })
  })

  it('ignores fuel that cannot even smelt one item, and unknown items', () => {
    expect(chooseFuel({ inventory: inventory({ stick: 1, dirt: 5 }), toSmelt: 1 })).toBeUndefined()
    expect(
      chooseFuel({ inventory: inventory({ dirt: 5 }), toSmelt: 1, preferred: 'dirt' }),
    ).toBeUndefined()
  })

  it('reports nothing when the named fuel is not carried', () => {
    expect(
      chooseFuel({ inventory: inventory({ coal: 4 }), toSmelt: 4, preferred: 'charcoal' }),
    ).toBeUndefined()
  })
})
