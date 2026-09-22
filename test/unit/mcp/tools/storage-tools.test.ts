import { describe, expect, it } from '@jest/globals'
import { MineflayerItemFacts } from '../../../../src/bot/mineflayer-item-facts.js'
import type { LookTarget } from '../../../../src/core/container.port.js'
import { ok } from '../../../../src/core/result.js'
import type { SkillContext, SkillResult } from '../../../../src/core/skill.types.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import {
  LabelContainerTool,
  ListContainersTool,
  RegisterContainerTool,
  RemoveContainerTool,
} from '../../../../src/mcp/tools/container-tools.js'
import {
  ResumeTaskTool,
  SetStoragePolicyTool,
} from '../../../../src/mcp/tools/storage-policy-tools.js'
import {
  ListStorageRulesTool,
  RemoveStorageRuleTool,
  SetStorageRuleTool,
} from '../../../../src/mcp/tools/storage-rule-tools.js'
import {
  DepositItemsTool,
  FindItemsTool,
  ScanContainersTool,
  WithdrawItemsTool,
} from '../../../../src/mcp/tools/storage-task-tools.js'
import type { ToolContext } from '../../../../src/mcp/tool.types.js'
import type { DepositItemsSkill } from '../../../../src/skills/storage/deposit-items-skill.js'
import type { FindItemsSkill } from '../../../../src/skills/storage/find-items-skill.js'
import type { ScanContainersSkill } from '../../../../src/skills/storage/scan-containers-skill.js'
import type { WithdrawItemsSkill } from '../../../../src/skills/storage/withdraw-items-skill.js'
import { ContainerIndex } from '../../../../src/state/container-index.js'
import { StandingInstructions } from '../../../../src/state/standing-instructions.js'
import { StoragePolicy } from '../../../../src/state/storage-policy.js'
import { StorageRules } from '../../../../src/state/storage-rules.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeBot } from '../../../fakes/fake-bot.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeBlockScanner } from '../../../fakes/fake-ports.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const context: ToolContext = { signal: new AbortController().signal }
const facts = new MineflayerItemFacts({
  current: () => new FakeBot().useGameData(),
  onChange: () => () => undefined,
})
const at = (x: number) => ({ x, y: 64, z: 0 })

async function state() {
  const store = new InMemoryStateStore()
  const clock = new FakeClock(Date.UTC(2026, 8, 19, 12))
  const index = new ContainerIndex(clock)
  const rules = new StorageRules()
  const policy = new StoragePolicy()
  const standing = new StandingInstructions()
  for (const part of [index, rules, policy, standing]) await part.attach(store)
  const tasks = new TaskManager({
    clock,
    scheduler: new FakeScheduler(clock),
    logger: new FakeLogger(),
  })
  return { index, rules, policy, standing, tasks, clock, launcher: new TaskLauncher(tasks, clock) }
}

describe('container tools', () => {
  async function tools(owner: string | null = 'Andrey_Knight') {
    const s = await state()
    const blocks = new FakeBlockScanner()
    blocks.names = ['chest', 'barrel', 'furnace', 'stone', 'red_shulker_box']
    const look: {
      hit:
        | { name: string; position: { x: number; y: number; z: number }; face: 'north' }
        | undefined
    } = { hit: undefined }
    const lookTarget: LookTarget = { blockLookedAt: () => look.hit }
    return {
      ...s,
      blocks,
      look,
      register: new RegisterContainerTool(s.index, s.rules, blocks, lookTarget, owner ?? undefined),
      label: new LabelContainerTool(s.index, s.rules),
      remove: new RemoveContainerTool(s.index, s.rules),
      list: new ListContainersTool(s.index, s.rules),
    }
  }

  it('registers a container by coordinates, with a label and the protected flag', async () => {
    const t = await tools()
    t.blocks.blockNames.set('4,64,0', 'chest')

    const result = t.register.execute(
      t.register.inputSchema.parse({ x: 4, y: 64, z: 0, label: 'home', protected: true }),
    )

    expect(result).toMatchObject({
      ok: true,
      data: {
        container: {
          id: 'container-1',
          label: 'home',
          block: 'chest',
          protected: true,
          position: at(4),
        },
      },
    })
  })

  it('wants exactly one way of pointing at it', async () => {
    const t = await tools()
    const valid = (input: unknown): boolean => t.register.inputSchema.safeParse(input).success

    expect(valid({ x: 1, y: 2, z: 3 })).toBe(true)
    expect(valid({ looking_at: true })).toBe(true)
    expect(valid({ nearest: true })).toBe(true)
    expect(valid({})).toBe(false)
    expect(valid({ x: 1, y: 2 })).toBe(false)
    expect(valid({ x: 1, y: 2, z: 3, nearest: true })).toBe(false)
    expect(valid({ looking_at: true, nearest: true })).toBe(false)
  })

  it('says why a place cannot be registered', async () => {
    const t = await tools()
    t.blocks.blockNames.set('1,64,0', 'furnace')

    expect(t.register.execute(t.register.inputSchema.parse({ x: 1, y: 64, z: 0 }))).toEqual({
      ok: false,
      error: 'That is furnace, not a container.',
    })
    expect(t.register.execute(t.register.inputSchema.parse({ x: 9, y: 64, z: 0 }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('not loaded') as unknown as string,
    })
  })

  it('registers the container the owner is looking at', async () => {
    const t = await tools()
    t.look.hit = { name: 'chest', position: at(6), face: 'north' }

    const result = t.register.execute(
      t.register.inputSchema.parse({ looking_at: true, label: 'wood' }),
    )

    expect(result).toMatchObject({
      ok: true,
      data: { container: { label: 'wood', position: at(6) } },
    })
  })

  it('explains when nobody is set as the owner, or the owner looks at nothing', async () => {
    const ownerless = await tools(null)
    const t = await tools()

    expect(
      ownerless.register.execute(ownerless.register.inputSchema.parse({ looking_at: true })),
    ).toMatchObject({ ok: false, error: expect.stringContaining('MC_OWNER') as unknown as string })
    expect(t.register.execute(t.register.inputSchema.parse({ looking_at: true }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('not looking at any block') as unknown as string,
    })
  })

  it('registers the nearest container, and says when there is none', async () => {
    const t = await tools()
    expect(t.register.execute(t.register.inputSchema.parse({ nearest: true }))).toMatchObject({
      ok: false,
    })

    t.blocks.blocks = [{ name: 'barrel', position: at(5), distance: 5 }]
    const result = t.register.execute(t.register.inputSchema.parse({ nearest: true }))

    expect(result).toMatchObject({ ok: true, data: { container: { block: 'barrel' } } })
  })

  it('relabels, protects, and removes containers together with their rules', async () => {
    const t = await tools()
    t.index.register(at(4), 'chest', { label: 'home' })
    t.rules.add('container-1', ['dirt'])

    const renamed = t.label.execute(
      t.label.inputSchema.parse({ container: 'home', label: 'base', protected: true }),
    )
    const missing = t.label.execute(t.label.inputSchema.parse({ container: 'nope' }))
    const removed = t.remove.execute(t.remove.inputSchema.parse({ container: 'base' }))

    expect(renamed).toMatchObject({
      ok: true,
      data: { container: { label: 'base', protected: true, rules: 1 } },
    })
    expect(missing.ok).toBe(false)
    expect(removed).toEqual({ ok: true, data: { removed: 'container-1' } })
    expect(t.rules.ordered()).toEqual([])
    expect(t.remove.execute(t.remove.inputSchema.parse({ container: 'base' })).ok).toBe(false)
  })

  it('lists containers with what they held, biggest first, and how many rules point at them', async () => {
    const t = await tools()
    t.index.register(at(4), 'chest', { label: 'home' })
    t.index.recordContents(
      'container-1',
      [
        { name: 'dirt', count: 5 },
        { name: 'coal', count: 50 },
      ],
      { totalSlots: 27, emptySlots: 25 },
    )
    t.rules.add('container-1', ['dirt'])

    const result = t.list.execute()

    expect(result).toMatchObject({
      ok: true,
      data: {
        count: 1,
        containers: [
          {
            id: 'container-1',
            label: 'home',
            rules: 1,
            emptySlots: 25,
            items: [
              { name: 'coal', count: 50 },
              { name: 'dirt', count: 5 },
            ],
          },
        ],
      },
    })
    t.index.detach()
    expect(t.list.execute().ok).toBe(false)
  })
})

describe('storage rule tools', () => {
  async function tools() {
    const s = await state()
    s.index.register(at(4), 'chest', { label: 'metal' })
    return {
      ...s,
      set: new SetStorageRuleTool(s.index, s.rules, facts),
      list: new ListStorageRulesTool(s.index, s.rules),
      remove: new RemoveStorageRuleTool(s.rules),
    }
  }

  it('saves a rule for items and groups, and lists it with the container label', async () => {
    const t = await tools()

    const set = t.set.execute(
      t.set.inputSchema.parse({ container: 'metal', items: ['ores', 'iron_ingot'], priority: 3 }),
    )
    const list = t.list.execute()

    expect(set).toMatchObject({
      ok: true,
      data: {
        rule: {
          id: 'rule-1',
          containerId: 'container-1',
          specs: ['ores', 'iron_ingot'],
          priority: 3,
        },
        container: 'metal',
      },
    })
    expect(list).toMatchObject({
      ok: true,
      data: { count: 1, rules: [{ id: 'rule-1', containerLabel: 'metal' }] },
    })
  })

  it('refuses unknown containers and names that are neither items nor groups', async () => {
    const t = await tools()

    expect(
      t.set.execute(t.set.inputSchema.parse({ container: 'nope', items: ['dirt'] })),
    ).toMatchObject({ ok: false, error: expect.stringContaining('register') as unknown as string })
    const bad = t.set.execute(
      t.set.inputSchema.parse({ container: 'metal', items: ['dirtt', 'oress'] }),
    )
    expect(bad).toMatchObject({
      ok: false,
      error: expect.stringContaining('dirtt, oress') as unknown as string,
    })
    expect(t.set.inputSchema.safeParse({ container: 'metal', items: [] }).success).toBe(false)
  })

  it('removes a rule, and reports errors from the store', async () => {
    const t = await tools()
    t.set.execute(t.set.inputSchema.parse({ container: 'metal', items: ['dirt'] }))

    expect(t.remove.execute({ rule: 'rule-1' })).toMatchObject({ ok: true })
    expect(t.remove.execute({ rule: 'rule-1' }).ok).toBe(false)
    t.rules.detach()
    expect(t.list.execute().ok).toBe(false)
  })
})

describe('storage policy and resume tools', () => {
  it('saves the policy with its limits and mirrors it as a standing instruction', async () => {
    const s = await state()
    const tool = new SetStoragePolicyTool(s.policy, s.standing)

    const result = tool.execute(
      tool.inputSchema.parse({ policy: 'offload_and_return', max_trips: 5, max_distance: 30 }),
    )

    expect(result).toEqual({
      ok: true,
      data: { policy: { kind: 'offload_and_return', maxTrips: 5, maxDistance: 30 } },
    })
    expect(s.standing.all().inventory_full).toContain('takes things to the chests')

    tool.execute(tool.inputSchema.parse({ policy: 'stop' }))
    expect(s.standing.all().inventory_full).toContain('ends the task')
    expect(s.policy.get()).toMatchObject({ kind: 'stop', maxTrips: 5 }) // limits stay when not given

    tool.execute(tool.inputSchema.parse({ policy: 'ask' }))
    expect(s.standing.all()).not.toHaveProperty('inventory_full')
  })

  it('fails without a world', () => {
    const tool = new SetStoragePolicyTool(new StoragePolicy(), new StandingInstructions())

    expect(tool.execute(tool.inputSchema.parse({ policy: 'stop' })).ok).toBe(false)
    expect(tool.inputSchema.safeParse({ policy: 'never' }).success).toBe(false)
  })

  it('gives a waiting task its answer', async () => {
    const s = await state()
    const tool = new ResumeTaskTool(s.tasks, s.clock)
    const answers: (string | undefined)[] = []
    s.tasks.start({
      name: 'collect_block',
      description: 'Collect',
      run: async (ctx) => {
        answers.push(await ctx.ask?.({ message: 'Full', options: ['offload', 'stop'] }))
        return ok('done')
      },
    })
    await new Promise((resolve) => setImmediate(resolve))

    const wrong = tool.execute(tool.inputSchema.parse({ decision: 'dance' }))
    const right = tool.execute(tool.inputSchema.parse({ decision: 'offload' }))
    await new Promise((resolve) => setImmediate(resolve))

    expect(wrong).toEqual({ ok: false, error: 'Choose one of: offload, stop.' })
    expect(right).toMatchObject({
      ok: true,
      data: { task: { status: 'running', waitingFor: null } },
    })
    expect(answers).toEqual(['offload'])
    expect(tool.execute(tool.inputSchema.parse({ decision: 'offload' })).ok).toBe(false)
  })
})

describe('storage task tools', () => {
  function stub<In>(
    name: string,
    run: (input: In, ctx: SkillContext) => SkillResult<unknown> = () => ok('done'),
  ) {
    const inputs: In[] = []
    return {
      inputs,
      skill: {
        name,
        run: (input: In, ctx: SkillContext) => (
          inputs.push(input),
          Promise.resolve(run(input, ctx))
        ),
      },
    }
  }

  it('deposit_items passes what to deposit and the options', async () => {
    const { launcher } = await state()
    const { skill, inputs } = stub('deposit_items')
    const tool = new DepositItemsTool(skill as unknown as DepositItemsSkill, launcher)

    const some = await tool.execute(
      tool.inputSchema.parse({
        items: ['ores'],
        container: 'metal',
        include_reserved: true,
        count: 4,
        max_distance: 30,
      }),
      context,
    )
    const all = await tool.execute(tool.inputSchema.parse({}), context)

    expect(inputs).toEqual([
      { specs: ['ores'], includeReserved: true, container: 'metal', count: 4, maxDistance: 30 },
      {
        specs: undefined,
        includeReserved: false,
        container: undefined,
        count: undefined,
        maxDistance: 64,
      },
    ])
    expect(some).toMatchObject({ ok: true, data: { description: 'Deposit ores' } })
    expect(all).toMatchObject({ ok: true, data: { description: 'Deposit items' } })
  })

  it('withdraw_items passes the requests', async () => {
    const { launcher } = await state()
    const { skill, inputs } = stub('withdraw_items')
    const tool = new WithdrawItemsTool(skill as unknown as WithdrawItemsSkill, launcher)

    const result = await tool.execute(
      tool.inputSchema.parse({
        items: [{ item: 'iron_ingot', count: 12 }, { item: 'coal' }],
        container: 'metal',
      }),
      context,
    )

    expect(inputs[0]).toEqual({
      requests: [
        { item: 'iron_ingot', count: 12 },
        { item: 'coal', count: undefined },
      ],
      container: 'metal',
    })
    expect(result).toMatchObject({ ok: true, data: { description: 'Withdraw iron_ingot / coal' } })
    expect(tool.inputSchema.safeParse({ items: [] }).success).toBe(false)
  })

  it('find_items and scan_containers pass their options', async () => {
    const { launcher } = await state()
    const find = stub('find_items')
    const scan = stub('scan_containers')
    const findTool = new FindItemsTool(find.skill as unknown as FindItemsSkill, launcher)
    const scanTool = new ScanContainersTool(scan.skill as unknown as ScanContainersSkill, launcher)

    await findTool.execute(
      findTool.inputSchema.parse({ item: 'iron_ingot', scan_if_missing: false, radius: 10 }),
      context,
    )
    await scanTool.execute(scanTool.inputSchema.parse({ replace: true }), context)

    expect(find.inputs[0]).toEqual({ query: 'iron_ingot', scanIfMissing: false, radius: 10 })
    expect(scan.inputs[0]).toEqual({ radius: 24, refreshKnown: true })
    expect(findTool.inputSchema.parse({ item: 'x' })).toMatchObject({
      scan_if_missing: true,
      radius: 24,
    })
  })
})
