import { describe, expect, it } from '@jest/globals'
import { MineflayerItemFacts } from '../../../../src/bot/mineflayer-item-facts.js'
import { ok } from '../../../../src/core/result.js'
import type { SkillContext, SkillResult } from '../../../../src/core/skill.types.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import {
  DropItemsTool,
  GiveItemsTool,
  ResolveItemTool,
} from '../../../../src/mcp/tools/handover-tools.js'
import type { ToolContext } from '../../../../src/mcp/tool.types.js'
import type { DropItemsSkill } from '../../../../src/skills/handover/drop-items-skill.js'
import type { GiveItemsSkill } from '../../../../src/skills/handover/give-items-skill.js'
import { ItemResolver } from '../../../../src/skills/handover/item-resolver.js'
import { ContainerIndex } from '../../../../src/state/container-index.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeBot } from '../../../fakes/fake-bot.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeInventory } from '../../../fakes/fake-ports.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const context: ToolContext = { signal: new AbortController().signal }

function launching() {
  const clock = new FakeClock(Date.UTC(2026, 8, 19, 12))
  const tasks = new TaskManager({
    clock,
    scheduler: new FakeScheduler(clock),
    logger: new FakeLogger(),
  })
  return { launcher: new TaskLauncher(tasks, clock) }
}

function stub<In>(
  name: string,
  run: (input: In, ctx: SkillContext) => SkillResult<unknown> = () => ok('done'),
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

describe('GiveItemsTool', () => {
  const tool = (owner: string | null = 'Andrey_Knight') => {
    const { launcher } = launching()
    const s = stub('give_items')
    return {
      ...s,
      tool: new GiveItemsTool(s.skill as unknown as GiveItemsSkill, launcher, owner ?? undefined),
    }
  }

  it('turns counts, stacks, and "all" into requests, and applies the defaults', async () => {
    const { tool: t, inputs } = tool()

    const result = await t.execute(
      t.inputSchema.parse({
        items: [
          { item: 'iron_ingot', count: 20 },
          { item: 'cobble', stacks: 3 },
          { item: 'coal', all: true },
          { item: 'dirt' },
        ],
      }),
      context,
    )

    expect(inputs[0]).toEqual({
      player: 'Andrey_Knight',
      requests: [
        { item: 'iron_ingot', amount: { kind: 'count', count: 20 } },
        { item: 'cobble', amount: { kind: 'stacks', stacks: 3 } },
        { item: 'coal', amount: { kind: 'all' } },
        { item: 'dirt', amount: { kind: 'count', count: 1 } },
      ],
      fetchFromStorage: true,
      keepReserve: true,
      mode: 'drop',
      chest: undefined,
    })
    expect(result).toMatchObject({
      ok: true,
      data: { description: 'Give iron_ingot / cobble / coal / dirt to Andrey_Knight' },
    })
  })

  it('passes on whether to take back what nobody picks up', async () => {
    const { tool: t, inputs } = tool()

    await t.execute(
      t.inputSchema.parse({ items: [{ item: 'dirt' }], recollect_unclaimed: false }),
      context,
    )

    expect(inputs[0]).toMatchObject({ recollectUnclaimed: false })
  })

  it('gives to the named player, in chest mode', async () => {
    const { tool: t, inputs } = tool()

    await t.execute(
      t.inputSchema.parse({
        items: [{ item: 'dirt', count: 5 }],
        player: 'Steve',
        mode: 'chest',
        chest: 'home',
        fetch_from_storage: false,
        keep_reserve: false,
      }),
      context,
    )

    expect(inputs[0]).toMatchObject({
      player: 'Steve',
      mode: 'chest',
      chest: 'home',
      fetchFromStorage: false,
      keepReserve: false,
    })
  })

  it('needs a player when there is no owner', async () => {
    const { tool: t } = tool(null)

    const result = await t.execute(t.inputSchema.parse({ items: [{ item: 'dirt' }] }), context)

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('MC_OWNER') as unknown as string,
    })
  })

  it('validates the entries', () => {
    const { tool: t } = tool()
    const valid = (input: unknown): boolean => t.inputSchema.safeParse(input).success

    expect(valid({ items: [] })).toBe(false)
    expect(valid({ items: [{ item: 'dirt', count: 5, stacks: 2 }] })).toBe(false)
    expect(valid({ items: [{ item: 'dirt', count: 5, all: true }] })).toBe(false)
    expect(valid({ items: [{ item: 'dirt', count: 0 }] })).toBe(false)
    expect(valid({ items: [{ item: 'dirt', all: false }] })).toBe(true)
    expect(valid({ items: [{ item: 'dirt' }], mode: 'mail' })).toBe(false)
  })
})

describe('DropItemsTool', () => {
  it('passes the requests and the reserve option', async () => {
    const { launcher } = launching()
    const { skill, inputs } = stub('drop_items')
    const tool = new DropItemsTool(skill as unknown as DropItemsSkill, launcher)

    const result = await tool.execute(
      tool.inputSchema.parse({ items: [{ item: 'dirt', all: true }], keep_reserve: false }),
      context,
    )

    expect(inputs[0]).toEqual({
      requests: [{ item: 'dirt', amount: { kind: 'all' } }],
      keepReserve: false,
    })
    expect(result).toMatchObject({ ok: true, data: { description: 'Drop dirt' } })
  })
})

describe('ResolveItemTool', () => {
  async function tool(connected = true) {
    const facts = new MineflayerItemFacts({
      current: () => new FakeBot().useGameData(),
      onChange: () => () => undefined,
    })
    const inventory = new FakeInventory()
    inventory.value = connected
      ? { stacks: [{ name: 'iron_ingot', count: 4 }], emptySlots: 30, heldItem: undefined }
      : undefined
    const index = new ContainerIndex(new FakeClock())
    await index.attach(new InMemoryStateStore())
    index.register({ x: 1, y: 64, z: 1 }, 'chest')
    index.recordContents('container-1', [{ name: 'raw_iron', count: 30 }], {
      totalSlots: 27,
      emptySlots: 26,
    })
    index.register({ x: 5, y: 64, z: 5 }, 'chest', { protected: true })
    index.recordContents('container-2', [{ name: 'iron_block', count: 9 }], {
      totalSlots: 27,
      emptySlots: 26,
    })
    return new ResolveItemTool(new ItemResolver(facts), inventory, index)
  }

  it('shows the candidates with what the bot carries and has in chests, ignoring protected ones', async () => {
    const t = await tool()

    const result = t.execute(t.inputSchema.parse({ item: 'iron' }))

    expect(result).toEqual({
      ok: true,
      data: {
        phrase: 'iron',
        kind: 'ambiguous',
        candidates: [
          { item: 'raw_iron', carried: 0, stored: 30 },
          { item: 'iron_ingot', carried: 4, stored: 0 },
        ],
      },
    })
  })

  it('shows what a clear word means, and fails when offline', async () => {
    const t = await tool()
    const offline = await tool(false)

    expect(t.execute(t.inputSchema.parse({ item: 'cobble' }))).toEqual({
      ok: true,
      data: { phrase: 'cobble', kind: 'items', items: ['cobblestone'], via: 'alias' },
    })
    expect(offline.execute(offline.inputSchema.parse({ item: 'cobble' }))).toEqual({
      ok: false,
      error: 'Not connected to a Minecraft world.',
    })
  })
})
