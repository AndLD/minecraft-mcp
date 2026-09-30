import { describe, expect, it } from '@jest/globals'
import {
  assess,
  DEFAULT_HOSTILE_RULE,
  FLEE_HYSTERESIS,
  LOW_HEALTH_FLEE_RADIUS,
  MOB_RULES,
} from '../../../src/reflexes/threat-policy.js'
import { entity, reflexState } from '../../fakes/reflex-fakes.js'

const options = { lowHealthThreshold: 8 }
const creeperRadius = MOB_RULES['creeper']?.radius ?? Number.NaN

describe('threat policy', () => {
  describe('the table', () => {
    it.each(['skeleton', 'stray', 'bogged', 'creeper'])('always flees from %s', (name) => {
      expect(MOB_RULES[name]?.action).toBe('flee')
    })

    it.each(['warden', 'wither', 'ender_dragon', 'elder_guardian'])(
      'flees from the boss or extreme threat %s',
      (name) => {
        expect(MOB_RULES[name]?.action).toBe('flee')
      },
    )

    it('ignores endermen', () => {
      expect(MOB_RULES['enderman']?.action).toBe('ignore')
    })

    it('fights every other hostile mob by default', () => {
      expect(DEFAULT_HOSTILE_RULE.action).toBe('fight')
    })
  })

  describe('with full health', () => {
    it.each([
      'skeleton',
      'stray',
      'bogged',
      'creeper',
      'warden',
      'wither',
      'ender_dragon',
      'elder_guardian',
    ])('flees from a nearby %s', (name) => {
      const state = reflexState({ entities: [entity(name, 6)] })

      expect(assess(state, options)).toMatchObject({ kind: 'flee', reason: 'dangerous_mob' })
    })

    it.each(['zombie', 'spider', 'husk', 'drowned', 'witch', 'cave_spider', 'silverfish', 'slime'])(
      'fights a nearby %s',
      (name) => {
        const target = entity(name, 5)

        expect(assess(reflexState({ entities: [target] }), options)).toEqual({
          kind: 'fight',
          target,
        })
      },
    )

    it('never touches an enderman', () => {
      expect(assess(reflexState({ entities: [entity('enderman', 2)] }), options)).toEqual({
        kind: 'none',
      })
    })

    it('fights the zombie next to an enderman, not the enderman', () => {
      const zombie = entity('zombie', 6)
      const state = reflexState({ entities: [entity('enderman', 2), zombie] })

      expect(assess(state, options)).toEqual({ kind: 'fight', target: zombie })
    })

    it('does nothing about animals, players, items, or far-away mobs', () => {
      const state = reflexState({
        entities: [
          entity('cow', 3, { category: 'animal' }),
          entity('Andrey_Knight', 4, { category: 'player' }),
          entity('item', 2, { category: 'object' }),
          entity('zombie', 9),
        ],
      })

      expect(assess(state, options)).toEqual({ kind: 'none' })
    })

    it('fights the nearest of several hostile mobs', () => {
      const near = entity('zombie', 3)
      const far = entity('spider', 7)

      expect(assess(reflexState({ entities: [near, far] }), options)).toEqual({
        kind: 'fight',
        target: near,
      })
    })

    it('flees rather than fights when a creeper is with the zombie', () => {
      const state = reflexState({ entities: [entity('zombie', 3), entity('creeper', 8)] })

      expect(assess(state, options)).toMatchObject({ kind: 'flee', reason: 'dangerous_mob' })
    })

    it.each([
      ['skeleton', 16],
      ['creeper', 10],
      ['warden', 24],
      ['zombie', 8],
    ])('reacts to a %s only within %s blocks', (name, radius) => {
      const inside = assess(reflexState({ entities: [entity(name, radius)] }), options)
      const outside = assess(reflexState({ entities: [entity(name, radius + 0.1)] }), options)

      expect(inside.kind).not.toBe('none')
      expect(outside).toEqual({ kind: 'none' })
    })
  })

  describe('at low health', () => {
    it('flees from a mob that would otherwise be fought', () => {
      const state = reflexState({ health: 8, entities: [entity('zombie', 5)] })

      expect(assess(state, options)).toMatchObject({ kind: 'flee', reason: 'low_health' })
    })

    it('fights at one point above the threshold, and flees at the threshold', () => {
      const zombie = entity('zombie', 5)

      expect(assess(reflexState({ health: 9, entities: [zombie] }), options).kind).toBe('fight')
      expect(assess(reflexState({ health: 8, entities: [zombie] }), options).kind).toBe('flee')
      expect(assess(reflexState({ health: 1, entities: [zombie] }), options).kind).toBe('flee')
    })

    it('flees from hostile mobs up to the low-health radius, even beyond their fight radius', () => {
      const zombie = entity('zombie', LOW_HEALTH_FLEE_RADIUS)

      expect(assess(reflexState({ health: 4, entities: [zombie] }), options)).toMatchObject({
        kind: 'flee',
        threats: [zombie],
      })
      expect(
        assess(
          reflexState({ health: 4, entities: [entity('zombie', LOW_HEALTH_FLEE_RADIUS + 1)] }),
          options,
        ),
      ).toEqual({ kind: 'none' })
    })

    it('still ignores endermen, and does nothing when only harmless creatures are near', () => {
      expect(
        assess(reflexState({ health: 2, entities: [entity('enderman', 3)] }), options),
      ).toEqual({ kind: 'none' })
      expect(
        assess(
          reflexState({ health: 2, entities: [entity('cow', 3, { category: 'animal' })] }),
          options,
        ),
      ).toEqual({ kind: 'none' })
    })

    it('respects a different threshold', () => {
      const state = reflexState({ health: 12, entities: [entity('zombie', 5)] })

      expect(assess(state, { lowHealthThreshold: 12 }).kind).toBe('flee')
      expect(assess(state, { lowHealthThreshold: 11 }).kind).toBe('fight')
    })

    it('lists every threat to run from', () => {
      const first = entity('zombie', 5)
      const second = entity('spider', 9)

      const assessment = assess(reflexState({ health: 3, entities: [first, second] }), options)

      expect(assessment).toMatchObject({ kind: 'flee', threats: [first, second] })
    })
  })

  describe('while already fleeing', () => {
    it('keeps running until the threat is well past its normal radius', () => {
      const creeper = entity('creeper', creeperRadius + FLEE_HYSTERESIS)

      expect(assess(reflexState({ entities: [creeper] }), options)).toEqual({ kind: 'none' })
      expect(assess(reflexState({ entities: [creeper] }), { ...options, fleeing: true }).kind).toBe(
        'flee',
      )
      expect(
        assess(
          reflexState({
            entities: [entity('creeper', creeperRadius + FLEE_HYSTERESIS + 1)],
          }),
          { ...options, fleeing: true },
        ),
      ).toEqual({ kind: 'none' })
    })
  })

  describe('bees', () => {
    it('fights a bee that is angry, and leaves a calm one alone', () => {
      const angry = entity('bee', 3, { category: 'passive', angry: true })
      const calm = entity('bee', 3, { category: 'passive', angry: false })

      expect(assess(reflexState({ entities: [angry] }), options)).toMatchObject({ kind: 'fight' })
      expect(assess(reflexState({ entities: [calm] }), options)).toEqual({ kind: 'none' })
    })

    it('ignores an angry bee that is farther than six blocks', () => {
      const far = entity('bee', 9, { category: 'passive', angry: true })

      expect(assess(reflexState({ entities: [far] }), options)).toEqual({ kind: 'none' })
    })
  })
})
