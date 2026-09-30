import { describe, expect, it } from '@jest/globals'
import { err, ok } from '../../../../src/core/result.js'
import type { SkillContext, SkillResult } from '../../../../src/core/skill.types.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import { CollectBlockTool } from '../../../../src/mcp/tools/collect-block-tool.js'
import type { CollectSaplingsSkill } from '../../../../src/skills/farming/collect-saplings-skill.js'
import type { StructuredGatherSkill } from '../../../../src/skills/gathering/structured-gather-skill.js'
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
import type { OpenVeinGatherSkill } from '../../../../src/skills/gathering/open-vein-gather-skill.js'
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
    const tool = new CollectBlockTool(skill as unknown as CollectBlocksSkill, undefined, launcher)
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
    const tool = new CollectBlockTool(skill as unknown as CollectBlocksSkill, undefined, launcher)

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
    const tool = new CollectBlockTool(skill as unknown as CollectBlocksSkill, undefined, launcher)

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
    const tool = new CollectBlockTool(skill as unknown as CollectBlocksSkill, undefined, launcher)

    await tool.execute(tool.inputSchema.parse({ blocks: ['oak_log'], count: 5 }), context)

    expect(tasks.latest()?.resume?.arguments).toMatchObject({ count: 1 })
  })
})

describe('CollectBlockTool: structured layout', () => {
  function stubStructured(run: () => SkillResult<unknown> = () => ok({ mined: 32, gained: [] })) {
    const inputs: unknown[] = []
    return {
      inputs,
      structured: {
        run: (input: unknown) => {
          inputs.push(input)
          return Promise.resolve(run())
        },
      } as unknown as StructuredGatherSkill,
    }
  }

  it('never offers a structured dig when none is wired in, whatever the request', async () => {
    const { launcher } = launching()
    const { skill, inputs } = stubSkill('collect_block', () => ok({ mined: 32, gained: [] }))
    const tool = new CollectBlockTool(skill as unknown as CollectBlocksSkill, undefined, launcher)

    await tool.execute(
      tool.inputSchema.parse({ blocks: ['dirt'], count: 32, layout: 'structured' }),
      context,
    )

    expect(inputs).toHaveLength(1) // the scattered skill ran; nothing else to call
  })

  it('never offers a structured dig for a group, several names, or a non-terrain block', async () => {
    const { launcher } = launching()
    const { skill } = stubSkill('collect_block', () => ok({ mined: 32, gained: [] }))
    const { structured, inputs } = stubStructured()
    const tool = new CollectBlockTool(skill as unknown as CollectBlocksSkill, structured, launcher)

    await tool.execute(tool.inputSchema.parse({ blocks: ['logs'], count: 32 }), context)
    await tool.execute(tool.inputSchema.parse({ blocks: ['dirt', 'sand'], count: 32 }), context)
    await tool.execute(
      tool.inputSchema.parse({ blocks: ['dirt'], count: 32, layout: 'structured' }),
      context,
    ) // still structured-eligible: covered by the next test, kept out of this count
    expect(inputs).toHaveLength(1) // only the last, terrain call reached the structured skill

    await tool.execute(
      tool.inputSchema.parse({ blocks: ['iron_ore'], count: 32, layout: 'structured' }),
      context,
    )
    expect(inputs).toHaveLength(1) // forcing "structured" on ore has no effect
  })

  it('layout: structured digs the shape even for a small count', async () => {
    const { launcher } = launching()
    const { skill, inputs: scatteredInputs } = stubSkill('collect_block', () =>
      ok({ mined: 3, gained: [] }),
    )
    const { structured, inputs } = stubStructured()
    const tool = new CollectBlockTool(skill as unknown as CollectBlocksSkill, structured, launcher)

    await tool.execute(
      tool.inputSchema.parse({ blocks: ['dirt'], count: 3, layout: 'structured' }),
      context,
    )

    expect(inputs).toEqual([{ block: 'dirt', count: 3, onInventoryFull: undefined }])
    expect(scatteredInputs).toHaveLength(0)
  })

  it('layout: scattered never tries the structured dig, however big the count', async () => {
    const { launcher } = launching()
    const { skill } = stubSkill('collect_block', () => ok({ mined: 40, gained: [] }))
    const { structured, inputs } = stubStructured()
    const tool = new CollectBlockTool(skill as unknown as CollectBlocksSkill, structured, launcher)

    await tool.execute(
      tool.inputSchema.parse({ blocks: ['dirt'], count: 40, layout: 'scattered' }),
      context,
    )

    expect(inputs).toHaveLength(0)
  })

  it('auto switches at structured_threshold and below it', async () => {
    const { launcher } = launching()
    const { skill } = stubSkill('collect_block', () => ok({ mined: 10, gained: [] }))
    const { structured, inputs } = stubStructured()
    const tool = new CollectBlockTool(skill as unknown as CollectBlocksSkill, structured, launcher)

    await tool.execute(tool.inputSchema.parse({ blocks: ['dirt'], count: 3 }), context) // below default 5
    expect(inputs).toHaveLength(0)

    await tool.execute(
      tool.inputSchema.parse({ blocks: ['dirt'], count: 3, structured_threshold: 3 }),
      context,
    )
    expect(inputs).toHaveLength(1)
  })

  it('returns the structured result, tagged with its layout, on success', async () => {
    const { launcher } = launching()
    const { skill } = stubSkill('collect_block', () => ok({ mined: 999, gained: [] }))
    const { structured } = stubStructured(() =>
      ok({
        mined: 32,
        requested: 32,
        gained: [{ name: 'dirt', count: 32 }],
        shape: 'quarry',
        origin: {},
      }),
    )
    const tool = new CollectBlockTool(skill as unknown as CollectBlocksSkill, structured, launcher)

    const result = await tool.execute(
      tool.inputSchema.parse({ blocks: ['dirt'], count: 32 }),
      context,
    )

    expect(result).toMatchObject({
      data: { result: { layout: 'structured', mined: 32, shape: 'quarry' } },
    })
  })

  it('falls back to the scattered dig, with the reason, when the site is not suitable', async () => {
    const { launcher } = launching()
    const { skill } = stubSkill('collect_block', () =>
      ok({ mined: 32, gained: [{ name: 'dirt', count: 32 }] }),
    )
    const { structured } = stubStructured(() =>
      err({ reason: 'protected_area', message: 'The plan reaches into "base".' }),
    )
    const tool = new CollectBlockTool(skill as unknown as CollectBlocksSkill, structured, launcher)

    const result = await tool.execute(
      tool.inputSchema.parse({ blocks: ['dirt'], count: 32 }),
      context,
    )

    expect(result).toMatchObject({
      data: {
        result: {
          layout: 'scattered',
          mined: 32,
          structuredFallbackReason: 'The plan reaches into "base".',
        },
      },
    })
  })

  it('reports the scattered failure directly when the fallback dig itself fails', async () => {
    const { launcher } = launching()
    const { skill } = stubSkill('collect_block', () =>
      err({ reason: 'block_not_found', message: 'No dirt found nearby.' }),
    )
    const { structured } = stubStructured(() =>
      err({ reason: 'protected_area', message: 'The plan reaches into "base".' }),
    )
    const tool = new CollectBlockTool(skill as unknown as CollectBlocksSkill, structured, launcher)

    const result = await tool.execute(
      tool.inputSchema.parse({ blocks: ['dirt'], count: 32 }),
      context,
    )

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('block_not_found') })
  })

  it('does not fall back and reports the failure directly when not connected', async () => {
    const { launcher } = launching()
    const { skill, inputs: scatteredInputs } = stubSkill('collect_block', () => ok({ mined: 0 }))
    const { structured } = stubStructured(() =>
      err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' }),
    )
    const tool = new CollectBlockTool(skill as unknown as CollectBlocksSkill, structured, launcher)

    const result = await tool.execute(
      tool.inputSchema.parse({ blocks: ['dirt'], count: 32 }),
      context,
    )

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('not_connected') })
    expect(scatteredInputs).toHaveLength(0) // never falls back for this reason
  })
})

describe('CollectBlockTool: saplings', () => {
  interface SaplingInput {
    species: string | undefined
    count: number
    maxLeaves: number | undefined
    maxDistance: number
    onInventoryFull: string | undefined
  }

  function wired(
    gained: { name: string; count: number }[],
    saplings: (input: SaplingInput) => SkillResult<unknown> = () => ok({ saplings: 3, leaves: 44 }),
  ) {
    const { launcher, tasks } = launching()
    const logs = stubSkill('collect_block', () => ok({ mined: 4, requested: 4, gained }))
    const got = stubSkill<SaplingInput>('collect_saplings', saplings)
    const tool = new CollectBlockTool(
      logs.skill as unknown as CollectBlocksSkill,
      undefined,
      launcher,
      got.skill as unknown as CollectSaplingsSkill,
    )
    return { tool, tasks, logs, got }
  }

  it('does nothing about saplings unless asked', async () => {
    const { tool, got } = wired([])

    const result = await tool.execute(tool.inputSchema.parse({ blocks: ['oak_log'], count: 4 }), context)

    expect(got.inputs).toEqual([])
    expect(result).toMatchObject({ ok: true, data: { result: { mined: 4 } } })
    expect(result.ok && (result.data as { result: object }).result).not.toHaveProperty('saplings')
  })

  it('collects the saplings of the species being cut once the logs are done', async () => {
    const { tool, got } = wired([{ name: 'oak_log', count: 4 }])

    const result = await tool.execute(
      tool.inputSchema.parse({ blocks: ['oak_log'], count: 4, saplings: 3, max_distance: 20 }),
      context,
    )

    expect(got.inputs[0]).toEqual({
      species: 'oak',
      count: 3,
      maxLeaves: undefined,
      maxDistance: 20,
      onInventoryFull: undefined,
    })
    expect(result).toMatchObject({
      ok: true,
      data: {
        result: {
          mined: 4,
          saplings: { requested: 3, gained: 3, leaves: 44, stoppedBecause: 'enough' },
        },
      },
    })
  })

  it('counts the saplings the log run already gained, and skips the leaves when that is enough', async () => {
    const some = wired([{ name: 'oak_sapling', count: 1 }, { name: 'birch_sapling', count: 9 }])
    const plenty = wired([{ name: 'oak_sapling', count: 5 }])

    await some.tool.execute(some.tool.inputSchema.parse({ blocks: ['oak_log'], saplings: 3 }), context)
    const enough = await plenty.tool.execute(
      plenty.tool.inputSchema.parse({ blocks: ['oak_log'], saplings: 3 }),
      context,
    )

    expect(some.got.inputs[0]).toMatchObject({ species: 'oak', count: 2 })
    expect(plenty.got.inputs).toEqual([])
    expect(enough).toMatchObject({
      ok: true,
      data: { result: { saplings: { requested: 3, gained: 5, leaves: 0, stoppedBecause: 'enough' } } },
    })
  })

  it('takes any species for a group of logs, and counts them all', async () => {
    const { tool, got } = wired([{ name: 'birch_sapling', count: 1 }])

    await tool.execute(tool.inputSchema.parse({ blocks: ['logs'], saplings: 2 }), context)

    expect(got.inputs[0]).toMatchObject({ species: undefined, count: 1 })
  })

  it('reports coming up short without failing the logs', async () => {
    const { tool } = wired([], () =>
      err({ reason: 'leaf_budget', message: 'Broke 120 leaves.', detail: { saplings: 2, requested: 5, leaves: 120 } }),
    )

    const result = await tool.execute(tool.inputSchema.parse({ blocks: ['oak_log'], saplings: 5 }), context)

    expect(result).toMatchObject({
      ok: true,
      data: {
        status: 'succeeded',
        result: { mined: 4, saplings: { requested: 5, gained: 2, leaves: 120, stoppedBecause: 'leaf_budget' } },
      },
    })
  })

  it('reports a failure without details as zero saplings', async () => {
    const { tool } = wired([], () => err({ reason: 'no_leaves', message: 'none' }))

    const result = await tool.execute(tool.inputSchema.parse({ blocks: ['oak_log'], saplings: 2 }), context)

    expect(result).toMatchObject({
      ok: true,
      data: { result: { saplings: { gained: 0, leaves: 0, stoppedBecause: 'no_leaves' } } },
    })
  })

  it('is cancelled when the sapling stage is', async () => {
    const { tool } = wired([], () => err({ reason: 'aborted', message: 'Cancelled.' }))

    const result = await tool.execute(tool.inputSchema.parse({ blocks: ['oak_log'], saplings: 2 }), context)

    expect(result).toMatchObject({ ok: false })
  })

  it('leaves a failed log run alone', async () => {
    const { launcher } = launching()
    const logs = stubSkill('collect_block', () => err({ reason: 'block_not_found', message: 'no logs' }))
    const got = stubSkill<SaplingInput>('collect_saplings')
    const tool = new CollectBlockTool(
      logs.skill as unknown as CollectBlocksSkill,
      undefined,
      launcher,
      got.skill as unknown as CollectSaplingsSkill,
    )

    await tool.execute(tool.inputSchema.parse({ blocks: ['oak_log'], saplings: 2 }), context)

    expect(got.inputs).toEqual([])
  })

  it('ignores saplings when no sapling skill is wired in', async () => {
    const { launcher } = launching()
    const logs = stubSkill('collect_block', () => ok({ mined: 1, gained: [] }))
    const tool = new CollectBlockTool(logs.skill as unknown as CollectBlocksSkill, undefined, launcher)

    const result = await tool.execute(tool.inputSchema.parse({ blocks: ['oak_log'], saplings: 2 }), context)

    expect(result).toMatchObject({ ok: true, data: { result: { mined: 1 } } })
  })

  it('remembers the saplings in what a resumed task asks for', async () => {
    const { tool, tasks } = wired([])

    await tool.execute(tool.inputSchema.parse({ blocks: ['oak_log'], count: 4, saplings: 3 }), context)

    expect(tasks.latest()?.resume?.arguments).toMatchObject({ blocks: ['oak_log'], saplings: 3 })
  })

  it('rejects a sapling count out of range', () => {
    const { tool } = wired([])

    expect(tool.inputSchema.safeParse({ blocks: ['oak_log'], saplings: 0 }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ blocks: ['oak_log'], saplings: 65 }).success).toBe(false)
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
      { item: 'raw_iron', count: 10, fuel: 'coal', wait: 'until_done', collect: false, fuelFromStorage: false },
      { item: 'sand', count: undefined, fuel: undefined, wait: 'until_done', collect: false, fuelFromStorage: false },
    ])
    expect(some).toMatchObject({ ok: true, data: { description: 'Smelt 10 raw_iron' } })
    expect(all).toMatchObject({ ok: true, data: { description: 'Smelt all sand' } })
  })

  it('smelt can start a job without waiting, and collect one without naming an item', async () => {
    const { launcher } = launching()
    const { skill, inputs } = stubSkill('smelt')
    const tool = new SmeltTool(skill as unknown as SmeltItemsSkill, launcher)

    const started = await tool.execute(
      tool.inputSchema.parse({ item: 'beef', wait: 'start_only' }),
      context,
    )
    const collected = await tool.execute(tool.inputSchema.parse({ collect: true }), context)

    expect(inputs).toEqual([
      { item: 'beef', count: undefined, fuel: undefined, wait: 'start_only', collect: false, fuelFromStorage: false },
      { item: '', count: undefined, fuel: undefined, wait: 'until_done', collect: true, fuelFromStorage: false },
    ])
    expect(started).toMatchObject({ ok: true, data: { description: 'Smelt all beef' } })
    expect(collected).toMatchObject({ ok: true, data: { description: 'Collect a smelting job' } })
  })

  it('smelt can be told to take fuel out of storage', async () => {
    const { launcher } = launching()
    const { skill, inputs } = stubSkill('smelt')
    const tool = new SmeltTool(skill as unknown as SmeltItemsSkill, launcher)

    await tool.execute(tool.inputSchema.parse({ item: 'raw_iron', fuel_from_storage: true }), context)

    expect(inputs[0]).toMatchObject({ item: 'raw_iron', fuelFromStorage: true })
    expect(tool.inputSchema.parse({ item: 'raw_iron' }).fuel_from_storage).toBe(false)
  })

  it('smelt asks for an item unless it is collecting', async () => {
    const { launcher } = launching()
    const { skill, inputs } = stubSkill('smelt')
    const tool = new SmeltTool(skill as unknown as SmeltItemsSkill, launcher)

    const result = await tool.execute(tool.inputSchema.parse({}), context)

    expect(result).toMatchObject({ ok: false })
    expect(inputs).toEqual([])
    expect(tool.inputSchema.safeParse({ item: 'beef', wait: 'sometimes' }).success).toBe(false)
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

describe('CollectBlockTool: open veins', () => {
  function withOpenVeins() {
    const { launcher, tasks } = launching()
    const collect = stubSkill('collect_block')
    const open = stubSkill('collect_block', () => ok({ mined: 2, requested: 2, gained: [], explored: 1, tunnelled: 0 }))
    const tool = new CollectBlockTool(
      collect.skill as unknown as CollectBlocksSkill,
      undefined,
      launcher,
      undefined,
      open.skill as unknown as OpenVeinGatherSkill,
    )
    return { tool, tasks, collect, open }
  }

  it('gathers ores by open veins by default, with the search options passed on', async () => {
    const { tool, collect, open } = withOpenVeins()

    const result = await tool.execute(tool.inputSchema.parse({ blocks: ['iron_ore'], count: 2 }), context)

    expect(open.inputs[0]).toMatchObject({
      names: ['iron_ore'],
      count: 2,
      maxDistance: 32,
      maxMinutes: 10,
      tunnel: false,
    })
    expect(collect.inputs).toEqual([])
    expect(result).toMatchObject({ ok: true, data: { result: { layout: 'open_veins', mined: 2, explored: 1 } } })
  })

  it('tunnels only with open_then_tunnel', async () => {
    const { tool, open } = withOpenVeins()

    await tool.execute(
      tool.inputSchema.parse({ blocks: ['ores'], search: 'open_then_tunnel', max_minutes: 30 }),
      context,
    )

    expect(open.inputs[0]).toMatchObject({ names: ['ores'], tunnel: true, maxMinutes: 30 })
  })

  it('keeps the older search with "nearest", and for anything that is not an ore', async () => {
    const { tool, collect, open } = withOpenVeins()

    await tool.execute(tool.inputSchema.parse({ blocks: ['iron_ore'], search: 'nearest' }), context)
    await tool.execute(tool.inputSchema.parse({ blocks: ['oak_log'] }), context)
    await tool.execute(tool.inputSchema.parse({ blocks: ['iron_ore', 'stone'] }), context)

    expect(open.inputs).toEqual([])
    expect(collect.inputs).toHaveLength(3)
  })

  it('works without the open-vein skill, as before', async () => {
    const { launcher } = launching()
    const collect = stubSkill('collect_block')
    const tool = new CollectBlockTool(collect.skill as unknown as CollectBlocksSkill, undefined, launcher)

    await tool.execute(tool.inputSchema.parse({ blocks: ['iron_ore'] }), context)

    expect(collect.inputs).toHaveLength(1)
  })

  it('reports a failure with its reason, and keeps the search in the resume', async () => {
    const { launcher, tasks } = launching()
    const open = stubSkill('collect_block', () =>
      err({ reason: 'no_open_vein', message: 'None found.', detail: { mined: 1 } }),
    )
    const tool = new CollectBlockTool(
      stubSkill('collect_block').skill as unknown as CollectBlocksSkill,
      undefined,
      launcher,
      undefined,
      open.skill as unknown as OpenVeinGatherSkill,
    )

    const result = await tool.execute(
      tool.inputSchema.parse({ blocks: ['diamond_ore'], search: 'open_then_tunnel' }),
      context,
    )

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('no_open_vein') })
    expect(tasks.latest()?.resume?.arguments).toMatchObject({
      search: 'open_then_tunnel',
      max_minutes: 10,
    })
  })

  it('validates the new options', () => {
    const { tool } = withOpenVeins()
    const valid = (input: unknown): boolean => tool.inputSchema.safeParse(input).success

    expect(valid({ blocks: ['iron_ore'], search: 'xray' })).toBe(false)
    expect(valid({ blocks: ['iron_ore'], max_minutes: 0 })).toBe(false)
    expect(valid({ blocks: ['iron_ore'], max_minutes: 61 })).toBe(false)
    expect(tool.inputSchema.parse({ blocks: ['iron_ore'] })).toMatchObject({ search: 'open' })
  })
})
