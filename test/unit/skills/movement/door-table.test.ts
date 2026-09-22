import { describe, expect, it } from '@jest/globals'
import { classifyDoor, isOpenableByHand } from '../../../../src/skills/movement/door-table.js'

describe('classifyDoor', () => {
  it.each([
    ['oak_door', 'door'],
    ['spruce_door', 'door'],
    ['crimson_door', 'door'],
    ['oak_fence_gate', 'gate'],
    ['warped_fence_gate', 'gate'],
    ['oak_trapdoor', 'trapdoor'],
    ['iron_door', 'iron'],
    ['iron_trapdoor', 'iron'],
  ] as const)('classifies %s as %s', (name, kind) => {
    expect(classifyDoor(name)).toBe(kind)
  })

  it('is undefined for anything else, including an iron fence-adjacent name', () => {
    expect(classifyDoor('stone')).toBeUndefined()
    expect(classifyDoor('oak_planks')).toBeUndefined()
    expect(classifyDoor('iron_bars')).toBeUndefined() // not a door, gate, or trapdoor at all
    expect(classifyDoor('chest')).toBeUndefined()
  })
})

describe('isOpenableByHand', () => {
  it('is true for wooden doors, gates, and trapdoors, false for iron and anything else', () => {
    expect(isOpenableByHand('oak_door')).toBe(true)
    expect(isOpenableByHand('birch_fence_gate')).toBe(true)
    expect(isOpenableByHand('dark_oak_trapdoor')).toBe(true)
    expect(isOpenableByHand('iron_door')).toBe(false)
    expect(isOpenableByHand('iron_trapdoor')).toBe(false)
    expect(isOpenableByHand('stone')).toBe(false)
  })
})
