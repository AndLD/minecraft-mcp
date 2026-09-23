import { describe, expect, it } from '@jest/globals'
import { foodFor, PENNABLE_SPECIES } from '../../../../src/skills/farming/animal-table.js'

describe('foodFor', () => {
  it.each([
    ['cow', 'wheat'],
    ['mooshroom', 'wheat'],
    ['sheep', 'wheat'],
    ['pig', 'carrot'],
    ['chicken', 'wheat_seeds'],
    ['rabbit', 'carrot'],
  ] as const)('gives %s the food %s', (species, food) => {
    expect(foodFor(species)).toBe(food)
  })

  it('is undefined for anything else', () => {
    expect(foodFor('zombie')).toBeUndefined()
    expect(foodFor('villager')).toBeUndefined()
  })

  it('covers every pennable species', () => {
    for (const species of PENNABLE_SPECIES) expect(foodFor(species)).toBeDefined()
  })
})
