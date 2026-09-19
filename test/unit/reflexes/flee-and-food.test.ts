import { describe, expect, it } from '@jest/globals'
import { distanceBetween } from '../../../src/core/position.js'
import { FLEE_DISTANCE, rankFleeDestinations } from '../../../src/reflexes/flee-planner.js'
import { AVOIDED_FOOD, chooseFood } from '../../../src/reflexes/food-choice.js'
import { FakeFoodCatalog } from '../../fakes/reflex-fakes.js'

const here = { x: 0, y: 64, z: 0 }

describe('rankFleeDestinations', () => {
  it('offers eight places, all the flee distance away, at the same height', () => {
    const destinations = rankFleeDestinations(here, [{ x: 5, y: 64, z: 0 }])

    expect(destinations).toHaveLength(8)
    for (const destination of destinations) {
      expect(distanceBetween(destination, here)).toBeCloseTo(FLEE_DISTANCE)
      expect(destination.y).toBe(64)
    }
  })

  it('puts the direction straight away from the threat first, and the one towards it last', () => {
    const [best, ...rest] = rankFleeDestinations(here, [{ x: 5, y: 64, z: 0 }])

    expect(best?.x).toBeCloseTo(-FLEE_DISTANCE)
    expect(best?.z).toBeCloseTo(0)
    expect(rest.at(-1)?.x).toBeCloseTo(FLEE_DISTANCE)
  })

  it('runs away from the nearest of several threats', () => {
    const [best] = rankFleeDestinations(here, [
      { x: 5, y: 64, z: 0 },
      { x: -8, y: 64, z: 0 },
    ])

    expect(Math.abs(best?.z ?? 0)).toBeGreaterThan(10) // sideways, away from both
  })

  it('prefers the side where a player or landmark is, when directions are otherwise equal', () => {
    const owner = { x: 0, y: 64, z: 30 }

    const [best] = rankFleeDestinations(here, [{ x: 0, y: 64, z: -5 }], owner)

    expect(best?.z).toBeGreaterThan(10)
  })

  it('still ranks all directions without threats', () => {
    expect(rankFleeDestinations(here, [])).toHaveLength(8)
  })
})

describe('chooseFood', () => {
  const stacks = (...names: string[]) => names.map((name) => ({ name, count: 1 }))

  it('picks the food that restores the most hunger', () => {
    expect(chooseFood(stacks('apple', 'bread', 'cooked_beef'), new FakeFoodCatalog())).toBe(
      'cooked_beef',
    )
  })

  it('breaks ties by saturation', () => {
    const catalog = new FakeFoodCatalog({
      a: { foodPoints: 6, saturation: 1 },
      b: { foodPoints: 6, saturation: 9 },
    })

    expect(chooseFood(stacks('a', 'b'), catalog)).toBe('b')
  })

  it('ignores items that are not food', () => {
    expect(chooseFood(stacks('cobblestone', 'stick'), new FakeFoodCatalog())).toBeUndefined()
    expect(chooseFood([], new FakeFoodCatalog())).toBeUndefined()
  })

  it.each([...AVOIDED_FOOD])('never eats %s automatically', (name) => {
    const catalog = new FakeFoodCatalog({ [name]: { foodPoints: 20, saturation: 20 } })

    expect(chooseFood(stacks(name), catalog)).toBeUndefined()
  })

  it('takes plain food when the best food is on the avoid list', () => {
    expect(chooseFood(stacks('golden_apple', 'apple', 'rotten_flesh'), new FakeFoodCatalog())).toBe(
      'apple',
    )
  })
})
