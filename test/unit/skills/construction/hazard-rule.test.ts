import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { HazardRule } from '../../../../src/skills/construction/hazard-rule.js'
import { cellKey } from '../../../../src/skills/construction/standing-spot.js'
import type { WorkPlan, WorkStep } from '../../../../src/skills/construction/work-plan.types.js'
import { ConstructionWorld } from '../../../fakes/construction-fakes.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })
type Break = Extract<WorkStep, { kind: 'break' }>
const dig = (x: number, y: number, z: number, patch: Partial<Break> = {}): Break => ({
  kind: 'break',
  at: at(x, y, z),
  ...patch,
})
const plan = (patch: Partial<WorkPlan> = {}): WorkPlan => ({ name: 'p', steps: [], ...patch })

/** Solid rock around (10, 50, 10). */
function rock() {
  const world = new ConstructionWorld(80)
  return { world, rule: new HazardRule(world) }
}
const none = { order: new Map<string, number>(), index: 0, dug: new Set<string>() }
const state = (patch: Partial<typeof none> = {}) => ({ ...none, ...patch })

describe('HazardRule: fluids', () => {
  const neighbours: [string, Position][] = [
    ['east', at(11, 50, 10)],
    ['west', at(9, 50, 10)],
    ['above', at(10, 51, 10)],
    ['below', at(10, 49, 10)],
    ['south', at(10, 50, 11)],
    ['north', at(10, 50, 9)],
  ]

  it.each(neighbours)('lava on the %s side ends the dig, and names where', (_side, where) => {
    const { world, rule } = rock()
    world.setBlock(where, 'lava')

    expect(rule.check(dig(10, 50, 10), plan(), none)).toEqual({ reason: 'hit_lava', at: where })
  })

  it.each(neighbours)('water on the %s side ends the dig', (_side, where) => {
    const { world, rule } = rock()
    world.setBlock(where, 'water')

    expect(rule.check(dig(10, 50, 10), plan(), none)).toEqual({ reason: 'hit_water', at: where })
  })

  it('also stops at a fluid in the very block to dig', () => {
    const { world, rule } = rock()
    world.setBlock(at(10, 50, 10), 'lava')

    expect(rule.check(dig(10, 50, 10), plan(), none)).toMatchObject({ reason: 'hit_lava' })
  })

  it('does not mind a fluid two blocks away, or a diagonal one', () => {
    const { world, rule } = rock()
    world.setBlock(at(12, 50, 10), 'lava')
    world.setBlock(at(11, 51, 10 + 1), 'water')

    expect(rule.check(dig(10, 50, 10), plan(), none)).toBeUndefined()
  })
})

describe('HazardRule: other things in the way', () => {
  it('leaves spawners, and chests, rails, and furnaces, alone', () => {
    const { world, rule } = rock()
    world.setBlock(at(10, 50, 10), 'spawner')
    expect(rule.check(dig(10, 50, 10), plan(), none)).toEqual({
      reason: 'spawner',
      at: at(10, 50, 10),
    })

    for (const name of [
      'chest',
      'trapped_chest',
      'barrel',
      'furnace',
      'rail',
      'powered_rail',
      'crafting_table',
    ]) {
      world.setBlock(at(10, 50, 10), name)
      expect(rule.check(dig(10, 50, 10), plan(), none)).toMatchObject({ reason: 'player_block' })
    }
  })

  it('stops at a block that is not loaded', () => {
    const { world, rule } = rock()
    world.unloaded.add(cellKey(at(10, 50, 10)))

    expect(rule.check(dig(10, 50, 10), plan(), none)).toEqual({
      reason: 'unloaded',
      at: at(10, 50, 10),
    })
  })

  it.each(['sand', 'red_sand', 'gravel', 'white_concrete_powder'])(
    'stops when %s overhead would fall into the opening',
    (name) => {
      const { world, rule } = rock()
      world.setBlock(at(10, 51, 10), name)

      expect(rule.check(dig(10, 50, 10), plan(), none)).toEqual({
        reason: 'falling_blocks',
        at: at(10, 51, 10),
        cells: [at(10, 51, 10)],
      })
    },
  )

  it('lists the whole column of falling blocks above, lowest first, and stops at the first block that stays', () => {
    const { world, rule } = rock()
    world.setBlock(at(10, 51, 10), 'gravel')
    world.setBlock(at(10, 52, 10), 'sand')
    world.setBlock(at(10, 53, 10), 'stone')
    world.setBlock(at(10, 54, 10), 'gravel')

    expect(rule.fallingAbove(at(10, 50, 10))).toEqual({
      reason: 'falling_blocks',
      at: at(10, 51, 10),
      cells: [at(10, 51, 10), at(10, 52, 10)],
    })
  })

  it('stops under gravel even when that cell is itself still to be dug: it would fall when this one opens', () => {
    const { world, rule } = rock()
    world.setBlock(at(10, 51, 10), 'gravel')
    const order = new Map([[cellKey(at(10, 51, 10)), 5]])

    expect(rule.check(dig(10, 50, 10), plan(), state({ order, index: 1 }))).toMatchObject({
      reason: 'falling_blocks',
    })
  })
})

describe('HazardRule: cave breakthrough', () => {
  const probe = [at(1, 0, 0), at(0, 1, 0)] // the way ahead and up

  it('ends the dig at an open cavity in the way, when the plan checks for them', () => {
    const { world, rule } = rock()
    world.setBlock(at(11, 50, 10), 'air')

    expect(rule.check(dig(10, 50, 10, { probe }), plan({ cavityCheck: true }), none)).toEqual({
      reason: 'cave_breakthrough',
      at: at(11, 50, 10),
    })
  })

  it('treats cave air the same', () => {
    const { world, rule } = rock()
    world.setBlock(at(10, 51, 10), 'cave_air')

    expect(rule.check(dig(10, 50, 10, { probe }), plan({ cavityCheck: true }), none)).toMatchObject(
      {
        reason: 'cave_breakthrough',
      },
    )
  })

  it('ignores it when the plan does not check, and when the step names no probes', () => {
    const { world, rule } = rock()
    world.setBlock(at(11, 50, 10), 'air')

    expect(rule.check(dig(10, 50, 10, { probe }), plan(), none)).toBeUndefined()
    expect(rule.check(dig(10, 50, 10), plan({ cavityCheck: true }), none)).toBeUndefined()
  })

  it('only looks where the step says: the way back is open, and that is fine', () => {
    const { world, rule } = rock()
    world.setBlock(at(9, 50, 10), 'air') // behind: where the bot came from

    expect(
      rule.check(dig(10, 50, 10, { probe }), plan({ cavityCheck: true }), none),
    ).toBeUndefined()
  })

  it('does not count openings the dig made itself: an earlier cell of the plan, or a mined ore', () => {
    const { world, rule } = rock()
    world.setBlock(at(11, 50, 10), 'air')
    const key = cellKey(at(11, 50, 10))

    const earlier = state({ order: new Map([[key, 0]]), index: 3 })
    const mined = state({ dug: new Set([key]) })
    expect(
      rule.check(dig(10, 50, 10, { probe }), plan({ cavityCheck: true }), earlier),
    ).toBeUndefined()
    expect(
      rule.check(dig(10, 50, 10, { probe }), plan({ cavityCheck: true }), mined),
    ).toBeUndefined()
  })

  it('does count an open cell that is still ahead in the plan: nobody dug it, so it is a cave', () => {
    const { world, rule } = rock()
    world.setBlock(at(11, 50, 10), 'air')
    const ahead = state({ order: new Map([[cellKey(at(11, 50, 10)), 9]]), index: 3 })

    expect(
      rule.check(dig(10, 50, 10, { probe }), plan({ cavityCheck: true }), ahead),
    ).toMatchObject({
      reason: 'cave_breakthrough',
    })
  })

  it('checks fluids before cavities', () => {
    const { world, rule } = rock()
    world.setBlock(at(11, 50, 10), 'air')
    world.setBlock(at(10, 49, 10), 'lava')

    expect(rule.check(dig(10, 50, 10, { probe }), plan({ cavityCheck: true }), none)).toMatchObject(
      {
        reason: 'hit_lava',
      },
    )
  })
})

describe('HazardRule: the checks on their own', () => {
  it('fluidNear finds lava or water in the cell or beside it, whatever the cell holds', () => {
    const { world, rule } = rock()
    world.setBlock(at(10, 50, 10), 'chest')
    expect(rule.fluidNear(at(10, 50, 10))).toBeUndefined()

    world.setBlock(at(11, 50, 10), 'lava')
    expect(rule.fluidNear(at(10, 50, 10))).toEqual({ reason: 'hit_lava', at: at(11, 50, 10) })
    world.setBlock(at(11, 50, 10), 'water')
    expect(rule.fluidNear(at(10, 50, 10))).toEqual({ reason: 'hit_water', at: at(11, 50, 10) })
  })

  it('fallingAbove finds sand, gravel, and concrete powder right above', () => {
    const { world, rule } = rock()
    expect(rule.fallingAbove(at(10, 50, 10))).toBeUndefined()

    world.setBlock(at(10, 51, 10), 'white_concrete_powder')
    expect(rule.fallingAbove(at(10, 50, 10))).toEqual({
      reason: 'falling_blocks',
      at: at(10, 51, 10),
      cells: [at(10, 51, 10)],
    })
    expect(rule.fallingAbove(at(10, 49, 10))).toBeUndefined()
  })
})
