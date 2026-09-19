import { describe, expect, it } from '@jest/globals'
import { ok } from '../../../../src/core/result.js'
import type { SkillContext, SkillResult } from '../../../../src/core/skill.types.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import { CollectBlockTool } from '../../../../src/mcp/tools/collect-block-tool.js'
import { CraftTool } from '../../../../src/mcp/tools/craft-tool.js'
import { ListRecipesTool } from '../../../../src/mcp/tools/list-recipes-tool.js'
import { PickupItemsTool } from '../../../../src/mcp/tools/pickup-items-tool.js'
import {
  ListProtectedAreasTool,
  ProtectAreaTool,
  UnprotectAreaTool,
} from '../../../../src/mcp/tools/protected-area-tools.js'
import { SmeltTool } from '../../../../src/mcp/tools/smelt-tool.js'
import type { ToolContext } from '../../../../src/mcp/tool.types.js'
import type { CraftItemSkill } from '../../../../src/skills/crafting/craft-item-skill.js'
import { RecipePlanner } from '../../../../src/skills/crafting/recipe-planner.js'
import type { CollectBlocksSkill } from '../../../../src/skills/gathering/collect-blocks-skill.js'
import type { PickupItemsSkill } from '../../../../src/skills/gathering/pickup-items-skill.js'
import type { SmeltItemsSkill } from '../../../../src/skills/smelting/smelt-items-skill.js'
import { ProtectedAreas } from '../../../../src/state/protected-areas.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeInventory } from '../../../fakes/fake-ports.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'
import { FakeRecipeBook, recipe } from '../../../fakes/gathering-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const context: ToolContext = { signal: new AbortController().signal }

function launching() {
  const clock = new FakeClock(Date.UTC(2026, 8, 19, 12, 0, 0))
  const tasks = new TaskManager({
    clock,
    scheduler: new FakeScheduler(clock),
    logger: new FakeLogger(),
  })
  return { tasks, launcher: new TaskLauncher(tasks, clock) }
}

/** A skill that records its input and finishes at once. */
function stubSkill<In>(
  name: string,
  run: (input: In, context: SkillContext) => SkillResult<unknown> = () => ok('done'),
) {
  const inputs: In[] = []
  return {
    inputs,
    skill: {
      name,
      run: (input: In, ctx: SkillContext) => {
        inputs.push(input)
        return Promise.resolve(run(input, ctx))
      },
    },
  }
}

describe('CollectBlockTool', () => {
  it('validates its arguments and applies defaults', () => {
    const { launcher } = launching()
    const { skill } = stubSkill('collect_block')
    const tool = new CollectBlockTool(skill as unknown as CollectBlocksSkill, launcher)
    const valid = (input: unknown): boolean => tool.inputSchema.safeParse(input).success

    expect(tool.inputSchema.parse({ blocks: ['oak_log'] })).toMatchObject({
      count: 1,
      max_distance: 32,
      replace: false,
    })
    expect(valid({ blocks: [] })).toBe(false)
    expect(valid({})).toBe(false)
    expect(valid({ blocks: ['oak_log'], count: 0 })).toBe(false)
    expect(valid({ blocks: ['oak_log'], count: 1.5 })).toBe(false)
    expect(valid({ blocks: ['oak_log'], max_distance: 100 })).toBe(false)
    expect(tool.description).toContain('"logs"')
  })

  it('starts a task with the blocks, count, and distance, and returns it finished', async () => {
    const { launcher } = launching()
    const { skill, inputs } = stubSkill('collect_block', () => ok({ mined: 3 }))
    const tool = new CollectBlockTool(skill as unknown as CollectBlocksSkill, launcher)

    const result = await tool.execute(
      tool.inputSchema.parse({ blocks: ['oak_log', 'birch_log'], count: 3, max_distance: 20 }),
      context,
    )

    expect(inputs[0]).toMatchObject({ names: ['oak_log', 'birch_log'], count: 3, maxDistance: 20 })
    expect(result).toMatchObject({
      ok: true,
      data: {
        name: 'collect_block',
        description: 'Collect 3 oak_log / birch_log',
        status: 'succeeded',
        result: { mined: 3 },
      },
    })
  })

  it('resumes with only what is still missing', async () => {
    const { launcher, tasks } = launching()
    const { skill } = stubSkill<{ onMined?: (n: number) => void }>('collect_block', (input) => {
      input.onMined?.(8)
      return ok('done')
    })
    const tool = new CollectBlockTool(skill as unknown as CollectBlocksSkill, launcher)

    const started = await tool.execute(
      tool.inputSchema.parse({ blocks: ['oak_log'], count: 20 }),
      context,
    )
    const snapshot = tasks.latest()

    expect(started.ok).toBe(true)
    expect(snapshot?.resume?.tool).toBe('collect_block')
    expect(snapshot?.resume?.arguments).toMatchObject({
      blocks: ['oak_log'],
      count: 12,
      max_distance: 32,
    })
    expect(snapshot?.resume?.arguments).not.toHaveProperty('wait_seconds')
  })

  it('always resumes with at least one block to go', async () => {
    const { launcher, tasks } = launching()
    const { skill } = stubSkill<{ onMined?: (n: number) => void }>('collect_block', (input) => {
      input.onMined?.(5)
      return ok('done')
    })
    const tool = new CollectBlockTool(skill as unknown as CollectBlocksSkill, launcher)

    await tool.execute(tool.inputSchema.parse({ blocks: ['oak_log'], count: 5 }), context)

    expect(tasks.latest()?.resume?.arguments).toMatchObject({ count: 1 })
  })
})

describe('PickupItemsTool, CraftTool, and SmeltTool', () => {
  it('pick up items with a distance, and can be resumed as they were called', async () => {
    const { launcher, tasks } = launching()
    const { skill, inputs } = stubSkill('pickup_items')
    const tool = new PickupItemsTool(skill as unknown as PickupItemsSkill, launcher)

    const result = await tool.execute(
      tool.inputSchema.parse({ items: ['apple'], max_distance: 8 }),
      context,
    )

    expect(inputs[0]).toEqual({ names: ['apple'], maxDistance: 8 })
    expect(result).toMatchObject({ ok: true, data: { description: 'Pick up apple' } })
    expect(tasks.latest()?.resume).toEqual({
      tool: 'pickup_items',
      arguments: { items: ['apple'], max_distance: 8 },
    })
    expect(tool.inputSchema.parse({})).toMatchObject({ items: [], max_distance: 12 })
  })

  it('pick up everything when no items are named', async () => {
    const { launcher } = launching()
    const { skill } = stubSkill('pickup_items')
    const tool = new PickupItemsTool(skill as unknown as PickupItemsSkill, launcher)

    const result = await tool.execute(tool.inputSchema.parse({}), context)

    expect(result).toMatchObject({ ok: true, data: { description: 'Pick up dropped items' } })
  })

  it('craft passes the item and count', async () => {
    const { launcher } = launching()
    const { skill, inputs } = stubSkill('craft')
    const tool = new CraftTool(skill as unknown as CraftItemSkill, launcher)

    const result = await tool.execute(tool.inputSchema.parse({ item: 'stick', count: 8 }), context)

    expect(inputs[0]).toEqual({ item: 'stick', count: 8 })
    expect(result).toMatchObject({ ok: true, data: { description: 'Craft 8 stick' } })
    expect(tool.inputSchema.parse({ item: 'stick' }).count).toBe(1)
    expect(tool.inputSchema.safeParse({ item: '' }).success).toBe(false)
  })

  it('smelt passes the item, count, and fuel', async () => {
    const { launcher } = launching()
    const { skill, inputs } = stubSkill('smelt')
    const tool = new SmeltTool(skill as unknown as SmeltItemsSkill, launcher)

    const some = await tool.execute(
      tool.inputSchema.parse({ item: 'raw_iron', count: 10, fuel: 'coal' }),
      context,
    )
    const all = await tool.execute(tool.inputSchema.parse({ item: 'sand', replace: true }), context)

    expect(inputs).toEqual([
      { item: 'raw_iron', count: 10, fuel: 'coal' },
      { item: 'sand', count: undefined, fuel: undefined },
    ])
    expect(some).toMatchObject({ ok: true, data: { description: 'Smelt 10 raw_iron' } })
    expect(all).toMatchObject({ ok: true, data: { description: 'Smelt all sand' } })
  })
})

describe('ListRecipesTool', () => {
  const book = new FakeRecipeBook({
    oak_planks: [recipe({ name: 'oak_planks', count: 4 }, [{ name: 'oak_log', count: 1 }])],
    stick: [recipe({ name: 'stick', count: 4 }, [{ name: 'oak_planks', count: 2 }])],
    wooden_pickaxe: [
      recipe(
        { name: 'wooden_pickaxe', count: 1 },
        [
          { name: 'oak_planks', count: 3 },
          { name: 'stick', count: 2 },
        ],
        0,
        true,
      ),
    ],
    oak_log: [],
  })

  function tool(items: Record<string, number> | undefined) {
    const inventory = new FakeInventory()
    inventory.value =
      items === undefined
        ? undefined
        : {
            stacks: Object.entries(items).map(([name, count]) => ({ name, count })),
            emptySlots: 30,
            heldItem: undefined,
          }
    return new ListRecipesTool(book, new RecipePlanner(book), inventory)
  }
  const run = (t: ReturnType<typeof tool>, input: Record<string, unknown>) =>
    t.execute(t.inputSchema.parse(input))

  it('shows the recipes for an item and whether it can be crafted now', () => {
    const result = run(tool({ oak_log: 2 }), { item: 'wooden_pickaxe' })

    expect(result).toEqual({
      ok: true,
      data: {
        item: 'wooden_pickaxe',
        recipes: [{ makes: 1, needs: '3 oak_planks, 2 stick', needsCraftingTable: true }],
        totalRecipes: 1,
        canCraftNow: true,
        steps: ['oak_planks x2', 'stick x1', 'wooden_pickaxe x1'],
        missing: [],
        needsCraftingTable: true,
      },
    })
  })

  it('says what is missing', () => {
    const result = run(tool({}), { item: 'stick' })

    expect(result).toMatchObject({
      ok: true,
      data: { canCraftNow: false, missing: [{ name: 'oak_log', count: 1 }] },
    })
  })

  it('explains an item without a recipe and an unknown name', () => {
    expect(run(tool({}), { item: 'oak_log' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('no crafting recipe') as unknown as string,
    })
    expect(run(tool({}), { item: 'nonsense' })).toEqual({
      ok: false,
      error: '"nonsense" is not an item name.',
    })
  })

  it('searches craftable names', () => {
    expect(run(tool({}), { search: 'PLANKS' })).toEqual({
      ok: true,
      data: { count: 1, items: ['oak_planks'] },
    })
  })

  it('lists what can be crafted right now', () => {
    const result = run(tool({ oak_log: 1, oak_planks: 2 }), { craftable_now: true })

    expect(result).toEqual({
      ok: true,
      data: {
        count: 2,
        items: [
          { item: 'oak_planks', makes: 4, needs: '1 oak_log', needsCraftingTable: false },
          { item: 'stick', makes: 4, needs: '2 oak_planks', needsCraftingTable: false },
        ],
      },
    })
  })

  it('wants exactly one question, and a connection', () => {
    expect(run(tool({}), {})).toMatchObject({ ok: false })
    expect(run(tool({}), { item: 'stick', search: 'x' })).toMatchObject({ ok: false })
    expect(run(tool(undefined), { item: 'stick' })).toEqual({
      ok: false,
      error: 'Not connected to a Minecraft world.',
    })
  })
})

describe('protected area tools', () => {
  async function tools() {
    const areas = new ProtectedAreas()
    await areas.attach(new InMemoryStateStore())
    return {
      areas,
      protect: new ProtectAreaTool(areas),
      unprotect: new UnprotectAreaTool(areas),
      list: new ListProtectedAreasTool(areas),
    }
  }

  it('protects a box, lists it, and removes it again', async () => {
    const { protect, unprotect, list } = await tools()

    const added = protect.execute(
      protect.inputSchema.parse({ label: 'house', x1: 0, y1: 60, z1: 0, x2: 10, y2: 70, z2: 10 }),
    )
    const listed = list.execute()
    const removed = unprotect.execute({ id: 'area-1' })

    expect(added).toMatchObject({ ok: true, data: { area: { id: 'area-1', label: 'house' } } })
    expect(listed).toMatchObject({ ok: true, data: { count: 1 } })
    expect(removed).toMatchObject({ ok: true, data: { removed: { id: 'area-1' } } })
    expect(list.execute()).toMatchObject({ ok: true, data: { count: 0 } })
  })

  it('reports errors from the store', async () => {
    const { protect, unprotect, areas, list } = await tools()

    expect(unprotect.execute({ id: 'area-7' })).toMatchObject({ ok: false })
    areas.detach()
    expect(
      protect.execute(
        protect.inputSchema.parse({ label: 'x', x1: 0, y1: 0, z1: 0, x2: 1, y2: 1, z2: 1 }),
      ),
    ).toMatchObject({ ok: false })
    expect(list.execute()).toMatchObject({ ok: false })
  })
})
