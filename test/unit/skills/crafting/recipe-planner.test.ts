import { describe, expect, it } from '@jest/globals'
import { MineflayerRecipes } from '../../../../src/bot/mineflayer-recipes.js'
import { RecipePlanner } from '../../../../src/skills/crafting/recipe-planner.js'
import { FakeBot } from '../../../fakes/fake-bot.js'
import { FakeRecipeBook, recipe } from '../../../fakes/gathering-fakes.js'

const holder = (bot: FakeBot) => ({ current: () => bot, onChange: () => () => undefined })
const inventory = (items: Record<string, number>): Map<string, number> =>
  new Map(Object.entries(items))

/** The planner against the real Minecraft 1.21.1 recipes. */
const gamePlanner = (): RecipePlanner =>
  new RecipePlanner(new MineflayerRecipes(holder(new FakeBot().useGameData())))

const stepsOf = (plan: ReturnType<RecipePlanner['plan']>): string[] =>
  plan.steps.map((step) => `${step.item} x${String(step.times)}`)

describe('RecipePlanner with the real recipes', () => {
  it('crafts planks from a log', () => {
    const plan = gamePlanner().plan([{ name: 'oak_planks', count: 4 }], inventory({ oak_log: 1 }))

    expect(stepsOf(plan)).toEqual(['oak_planks x1'])
    expect(plan.missing).toEqual([])
    expect(plan.needsTable).toBe(false)
  })

  it('makes a wooden pickaxe from logs: planks, sticks, then the pickaxe on a table', () => {
    const plan = gamePlanner().plan(
      [{ name: 'wooden_pickaxe', count: 1 }],
      inventory({ birch_log: 2 }),
    )

    // 3 planks + 2 sticks (2 more planks) = 5 planks, which takes two logs.
    expect(stepsOf(plan)).toEqual(['birch_planks x2', 'stick x1', 'wooden_pickaxe x1'])
    expect(plan.missing).toEqual([])
    expect(plan.needsTable).toBe(true)
  })

  it('uses the wood type that is carried, not the first one in the recipe list', () => {
    const plan = gamePlanner().plan(
      [{ name: 'crafting_table', count: 1 }],
      inventory({ jungle_planks: 4 }),
    )

    expect(stepsOf(plan)).toEqual(['crafting_table x1'])
    expect(plan.steps[0]?.recipe.ingredients).toEqual([{ name: 'jungle_planks', count: 4 }])
  })

  it('mixes wood types across ingredients when one type is not enough', () => {
    // A pickaxe needs 3 planks + 2 sticks (2 planks make 4 sticks). One oak log makes only 4 planks.
    const plan = gamePlanner().plan(
      [{ name: 'wooden_pickaxe', count: 1 }],
      inventory({ oak_log: 1, birch_log: 1 }),
    )

    expect(plan.missing).toEqual([])
    const made = new Set(plan.steps.map((step) => step.item))
    expect(made).toContain('oak_planks')
    expect(made).toContain('birch_planks')
  })

  it('makes more than one, rounding recipe runs up', () => {
    const plan = gamePlanner().plan([{ name: 'stick', count: 5 }], inventory({ oak_planks: 4 }))

    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]).toMatchObject({ item: 'stick', times: 2 })
  })

  it('crafts an item again even when some are carried', () => {
    const plan = gamePlanner().plan(
      [{ name: 'crafting_table', count: 1 }],
      inventory({ crafting_table: 1, oak_planks: 4 }),
    )

    expect(stepsOf(plan)).toEqual(['crafting_table x1'])
  })

  it('reports what is missing for a wooden pickaxe with an empty inventory, in oak', () => {
    const plan = gamePlanner().plan([{ name: 'wooden_pickaxe', count: 1 }], inventory({}))

    expect(plan.steps).toEqual([])
    expect(plan.missing).toEqual([{ name: 'oak_log', count: 2 }])
  })

  it('reports what is missing when the materials fall short', () => {
    const plan = gamePlanner().plan(
      [{ name: 'iron_pickaxe', count: 1 }],
      inventory({ oak_planks: 2, iron_ingot: 1 }),
    )

    expect(plan.missing).toEqual(expect.arrayContaining([{ name: 'iron_ingot', count: 2 }]))
    expect(plan.steps).toEqual([])
  })

  it('plans a table first when asked for both goals', () => {
    const plan = gamePlanner().plan(
      [
        { name: 'crafting_table', count: 1 },
        { name: 'wooden_pickaxe', count: 1 },
      ],
      inventory({ oak_log: 3 }),
    )

    expect(plan.missing).toEqual([])
    expect(plan.steps.map((s) => s.item)).toContain('crafting_table')
    expect(plan.steps.at(-1)?.item).toBe('wooden_pickaxe')
  })

  it('crafts a furnace from cobblestone and finds nothing for a raw item', () => {
    const planner = gamePlanner()

    expect(
      stepsOf(planner.plan([{ name: 'furnace', count: 1 }], inventory({ cobblestone: 8 }))),
    ).toEqual(['furnace x1'])
    expect(planner.plan([{ name: 'cobblestone', count: 3 }], inventory({}))).toMatchObject({
      steps: [],
      missing: [{ name: 'cobblestone', count: 3 }],
    })
  })

  it('lists what can be crafted in one step from what is carried', () => {
    const now = gamePlanner().craftableNow(inventory({ oak_log: 1 }))

    expect(now.map((entry) => entry.item)).toContain('oak_planks')
    expect(now.map((entry) => entry.item)).not.toContain('stick')
  })
})

describe('RecipePlanner with small recipe tables', () => {
  const book = new FakeRecipeBook({
    plank: [recipe({ name: 'plank', count: 4 }, [{ name: 'log', count: 1 }])],
    stick: [recipe({ name: 'stick', count: 4 }, [{ name: 'plank', count: 2 }])],
    axe: [
      recipe(
        { name: 'axe', count: 1 },
        [
          { name: 'plank', count: 3 },
          { name: 'stick', count: 2 },
        ],
        0,
        true,
      ),
    ],
    // A cycle: ingot <-> block.
    ingot: [recipe({ name: 'ingot', count: 9 }, [{ name: 'block', count: 1 }])],
    block: [recipe({ name: 'block', count: 1 }, [{ name: 'ingot', count: 9 }])],
    tool: [recipe({ name: 'tool', count: 1 }, [{ name: 'ingot', count: 3 }])],
  })
  const planner = new RecipePlanner(book)

  it('orders ingredient crafts before what they make, sharing one craft of a shared ingredient', () => {
    const plan = planner.plan([{ name: 'axe', count: 1 }], inventory({ log: 2 }))

    expect(plan.steps.map((s) => `${s.item}:${String(s.times)}`)).toEqual([
      'plank:2',
      'stick:1',
      'axe:1',
    ])
    expect(plan.needsTable).toBe(true)
  })

  it('reuses leftovers of an earlier craft', () => {
    // 2 logs give 8 planks: 3 for the axe and 2 for the sticks leave 3 spare.
    const plan = planner.plan(
      [
        { name: 'axe', count: 1 },
        { name: 'stick', count: 4 },
      ],
      inventory({ log: 2 }),
    )

    expect(plan.missing).toEqual([])
  })

  it('does not loop on recipe cycles', () => {
    const plan = planner.plan([{ name: 'tool', count: 1 }], inventory({}))

    expect(plan.steps).toEqual([])
    expect(plan.missing.length).toBeGreaterThan(0)
  })

  it('breaks a block into ingots when the block is carried', () => {
    const plan = planner.plan([{ name: 'tool', count: 1 }], inventory({ block: 1 }))

    expect(plan.steps.map((s) => s.item)).toEqual(['ingot', 'tool'])
  })

  it('reports the shortfall and does not craft when quantities do not add up', () => {
    const plan = planner.plan([{ name: 'axe', count: 3 }], inventory({ log: 1 }))

    expect(plan.steps).toEqual([])
    expect(plan.missing.length).toBeGreaterThan(0)
  })

  it('gives up cleanly on an item nobody can make', () => {
    const plan = planner.plan([{ name: 'unobtainium', count: 2 }], inventory({}))

    expect(plan).toEqual({
      steps: [],
      missing: [{ name: 'unobtainium', count: 2 }],
      needsTable: false,
    })
  })
})
