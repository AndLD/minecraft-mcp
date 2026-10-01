import { describe, expect, it } from '@jest/globals'
import { classifySwitch } from '../../../../src/skills/movement/switch-table.js'

describe('classifySwitch', () => {
  it.each([
    ['lever', 'lever'],
    ['stone_button', 'button'],
    ['oak_button', 'button'],
    ['polished_blackstone_button', 'button'],
    ['stone_pressure_plate', 'plate'],
    ['oak_pressure_plate', 'plate'],
    ['light_weighted_pressure_plate', 'plate'],
    ['heavy_weighted_pressure_plate', 'plate'],
  ] as const)('classifies %s as %s', (name, kind) => {
    expect(classifySwitch(name)).toBe(kind)
  })

  it('is undefined for anything else, including doors', () => {
    expect(classifySwitch('stone')).toBeUndefined()
    expect(classifySwitch('oak_door')).toBeUndefined()
    expect(classifySwitch('redstone')).toBeUndefined()
    expect(classifySwitch('chest')).toBeUndefined()
  })
})
