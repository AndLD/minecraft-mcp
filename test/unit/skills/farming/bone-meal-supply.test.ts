import { describe, expect, it } from '@jest/globals'
import { ok } from '../../../../src/core/result.js'
import { BoneMealSupply } from '../../../../src/skills/farming/bone-meal-supply.js'
import type { WithdrawInput } from '../../../../src/skills/storage/withdraw-items-skill.js'
import { Bag } from '../../../fakes/bag-fakes.js'
import { skillContext } from '../../../fakes/gathering-fakes.js'

/** A storage holding `chest`, a scanner that opens `hidden` into it, and a crafter that turns a bone into 3 bone meal. */
function setup(bag: Bag, chest: Record<string, number>, hidden: Record<string, number> = {}) {
  const asked: string[] = []
  const scans: number[] = []
  const crafts: { item: string; count: number }[] = []
  const supply = new BoneMealSupply({
    inventory: bag,
    withdraw: {
      run: (input: WithdrawInput) => {
        for (const { item, count } of input.requests) {
          asked.push(`${item} ${String(count)}`)
          const take = Math.min(count ?? 0, chest[item] ?? 0)
          chest[item] = (chest[item] ?? 0) - take
          bag.give(item, take)
        }
        return Promise.resolve(ok({ withdrawn: [], shortfall: [], container: undefined } as never))
      },
    },
    crafter: {
      run: (input) => {
        crafts.push(input)
        const bones = Math.ceil(input.count / 3)
        bag.give('bone', -bones)
        bag.give('bone_meal', bones * 3)
        return Promise.resolve(
          ok({ item: 'bone_meal', produced: bones * 3, steps: [], placedTable: false }),
        )
      },
    },
    scanner: {
      run: () => {
        scans.push(1)
        Object.assign(chest, hidden)
        return Promise.resolve(ok({} as never))
      },
    },
  })
  return { supply, asked, scans, crafts }
}

const none = { fromStorage: false, craft: false }

describe('BoneMealSupply', () => {
  it('does nothing when the bag has enough', async () => {
    const bag = new Bag({ bone_meal: 5 })
    const { supply, asked } = setup(bag, {})
    const { context } = skillContext()

    expect(await supply.ensure(5, { fromStorage: true, craft: true }, context)).toEqual({
      have: 5,
      fetched: 0,
      crafted: 0,
    })
    expect(asked).toEqual([])
  })

  it('takes only what the allowed sources give: nothing without them', async () => {
    const bag = new Bag({})
    const { supply, asked } = setup(bag, { bone_meal: 9 })
    const { context } = skillContext()

    expect((await supply.ensure(4, none, context)).have).toBe(0)
    expect(asked).toEqual([])
  })

  it('fetches bone meal from storage, scanning once for a chest it has not opened', async () => {
    const bag = new Bag({ bone_meal: 1 })
    const { supply, asked, scans } = setup(bag, {}, { bone_meal: 10 })
    const { context } = skillContext()

    const outcome = await supply.ensure(6, { fromStorage: true, craft: false }, context)

    expect(outcome).toEqual({ have: 6, fetched: 5, crafted: 0 })
    expect(scans).toHaveLength(1)
    expect(asked).toEqual(['bone_meal 5', 'bone_meal 5'])
  })

  it('crafts bones into bone meal, three per bone', async () => {
    const bag = new Bag({ bone: 4 })
    const { supply, crafts } = setup(bag, {})
    const { context } = skillContext()

    const outcome = await supply.ensure(7, { fromStorage: false, craft: true }, context)

    expect(crafts).toEqual([{ item: 'bone_meal', count: 9 }])
    expect(outcome).toEqual({ have: 9, fetched: 0, crafted: 9 })
    expect(bag.count('bone')).toBe(1)
  })

  it('takes bones out of storage to craft when the bag has none', async () => {
    const bag = new Bag({})
    const { supply, asked } = setup(bag, { bone: 5 })
    const { context } = skillContext()

    const outcome = await supply.ensure(6, { fromStorage: true, craft: true }, context)

    expect(asked).toContain('bone 2')
    expect(outcome.crafted).toBe(6)
  })

  it('never goes to storage or crafts when cancelled', async () => {
    const bag = new Bag({})
    const { supply, asked, crafts } = setup(bag, { bone_meal: 9 })
    const { context, controller } = skillContext()
    controller.abort()

    await supply.ensure(3, { fromStorage: true, craft: true }, context)

    expect([asked, crafts]).toEqual([[], []])
  })
})
