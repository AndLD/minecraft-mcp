import { describe, expect, it } from '@jest/globals'
import { ok } from '../../../../src/core/result.js'
import type { SkillContext, SkillResult } from '../../../../src/core/skill.types.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import { AttackEntityTool } from '../../../../src/mcp/tools/attack-entity-tool.js'
import { HuntAnimalsTool } from '../../../../src/mcp/tools/hunt-animals-tool.js'
import { ListHuntableAnimalsTool } from '../../../../src/mcp/tools/list-huntable-animals-tool.js'
import { SetFoodPolicyTool } from '../../../../src/mcp/tools/set-food-policy-tool.js'
import type { ToolContext } from '../../../../src/mcp/tool.types.js'
import type { AttackEntitySkill } from '../../../../src/skills/hunting/attack-entity-skill.js'
import type { HuntAnimalsSkill } from '../../../../src/skills/hunting/hunt-animals-skill.js'
import { PenDetector } from '../../../../src/skills/hunting/pen-detector.js'
import { FoodPolicy } from '../../../../src/state/food-policy.js'
import { StandingInstructions } from '../../../../src/state/standing-instructions.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeBlockScanner } from '../../../fakes/fake-ports.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'
import { animal, FakeAnimalScanner } from '../../../fakes/hunting-fakes.js'
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

function stubSkill<In>(
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

describe('HuntAnimalsTool', () => {
  function tool(run?: Parameters<typeof stubSkill<{ onProgress?: (n: number) => void }>>[1]) {
    const world = launching()
    const stub = stubSkill<Record<string, unknown> & { onProgress?: (n: number) => void }>(
      'hunt_animals',
      run,
    )
    return {
      ...world,
      ...stub,
      tool: new HuntAnimalsTool(stub.skill as unknown as HuntAnimalsSkill, world.launcher),
    }
  }

  it('wants exactly one of item or species, and applies defaults', () => {
    const { tool: t } = tool()
    const valid = (input: unknown): boolean => t.inputSchema.safeParse(input).success

    expect(valid({ item: 'beef' })).toBe(true)
    expect(valid({ species: ['cow'] })).toBe(true)
    expect(valid({})).toBe(false)
    expect(valid({ item: 'beef', species: ['cow'] })).toBe(false)
    expect(valid({ item: 'beef', count: 0 })).toBe(false)
    expect(t.inputSchema.parse({ item: 'beef' })).toMatchObject({
      count: 1,
      radius: 24,
      keep_breeders: true,
      allow_babies: false,
      include_pens: false,
      cook: false,
      time_limit_seconds: 300,
    })
  })

  it('turns an item goal into species and a raw item, and cooks for a cooked item', async () => {
    const { tool: t, inputs } = tool()

    const result = await t.execute(t.inputSchema.parse({ item: 'cooked_beef', count: 10 }), context)

    expect(inputs[0]).toMatchObject({
      species: ['cow', 'mooshroom'],
      goal: { kind: 'items', item: 'beef', count: 10 },
      cook: true,
      keepBreeders: true,
      timeLimitMs: 300_000,
    })
    expect(result).toMatchObject({
      ok: true,
      data: { description: 'Hunt for 10 cooked_beef', status: 'succeeded' },
    })
  })

  it('hunts a number of animals of the named species', async () => {
    const { tool: t, inputs } = tool()

    const result = await t.execute(
      t.inputSchema.parse({
        species: ['pig', 'sheep'],
        count: 3,
        radius: 40,
        allow_babies: true,
        include_pens: true,
        keep_breeders: false,
        cook: true,
      }),
      context,
    )

    expect(inputs[0]).toMatchObject({
      species: ['pig', 'sheep'],
      goal: { kind: 'animals', count: 3 },
      radius: 40,
      allowBabies: true,
      includePens: true,
      keepBreeders: false,
      cook: true,
    })
    expect(result).toMatchObject({ ok: true, data: { description: 'Hunt 3 pig / sheep' } })
  })

  it('says which items no livestock drops', async () => {
    const { tool: t } = tool()

    const result = await t.execute(t.inputSchema.parse({ item: 'diamond' }), context)

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('diamond') as unknown as string,
    })
  })

  it('resumes with only what is still to do', async () => {
    const { tool: t, tasks } = tool((input) => {
      input.onProgress?.(4)
      return ok('done')
    })

    await t.execute(t.inputSchema.parse({ species: ['cow'], count: 10 }), context)

    expect(tasks.latest()?.resume?.tool).toBe('hunt_animals')
    expect(tasks.latest()?.resume?.arguments).toMatchObject({
      species: ['cow'],
      count: 6,
      radius: 24,
    })
    expect(tasks.latest()?.resume?.arguments).not.toHaveProperty('wait_seconds')
  })
})

describe('AttackEntityTool', () => {
  function tool() {
    const world = launching()
    const stub = stubSkill('attack_entity')
    return {
      ...stub,
      tool: new AttackEntityTool(stub.skill as unknown as AttackEntitySkill, world.launcher),
    }
  }

  it('wants exactly one of entity_id or species', () => {
    const { tool: t } = tool()

    expect(t.inputSchema.safeParse({ entity_id: 5 }).success).toBe(true)
    expect(t.inputSchema.safeParse({ species: 'cow' }).success).toBe(true)
    expect(t.inputSchema.safeParse({}).success).toBe(false)
    expect(t.inputSchema.safeParse({ entity_id: 5, species: 'cow' }).success).toBe(false)
  })

  it('attacks by id or by nearest species, with the force flag', async () => {
    const { tool: t, inputs } = tool()

    const byId = await t.execute(t.inputSchema.parse({ entity_id: 5, force: true }), context)
    const bySpecies = await t.execute(t.inputSchema.parse({ species: 'cow', radius: 10 }), context)

    expect(inputs).toEqual([
      { target: { kind: 'id', id: 5 }, force: true, radius: 16 },
      { target: { kind: 'nearest', species: 'cow' }, force: false, radius: 10 },
    ])
    expect(byId).toMatchObject({ ok: true, data: { description: 'Attack animal 5' } })
    expect(bySpecies).toMatchObject({ ok: true, data: { description: 'Attack the nearest cow' } })
  })
})

describe('ListHuntableAnimalsTool', () => {
  function tool() {
    const scanner = new FakeAnimalScanner()
    return {
      scanner,
      tool: new ListHuntableAnimalsTool(scanner, new PenDetector(new FakeBlockScanner())),
    }
  }
  const run = (t: ReturnType<typeof tool>['tool'], input: Record<string, unknown> = {}) =>
    t.execute(t.inputSchema.parse(input))

  it('lists species counts and every animal with its status', () => {
    const { scanner, tool: t } = tool()
    scanner.animals = [
      animal('cow', 3),
      animal('cow', 5),
      animal('cow', 7),
      animal('cow', 9, { baby: true }),
      animal('wolf', 4, { owned: true }),
      animal('pig', 6, { named: true }),
    ]

    const result = run(t)

    expect(result).toMatchObject({
      ok: true,
      data: {
        species: [
          { species: 'cow', livestock: true, adults: 3, babies: 1, huntable: 3 },
          { species: 'pig', livestock: true, adults: 1, babies: 0, huntable: 0 },
          { species: 'wolf', livestock: false, adults: 1, babies: 0, huntable: 0 },
        ],
        truncated: false,
      },
    })
    const animals = (result.ok ? result.data : { animals: [] }) as {
      animals: { species: string; status: string }[]
    }
    expect(animals.animals.map((a) => [a.species, a.status])).toEqual([
      ['cow', 'huntable'],
      ['wolf', 'is tamed'],
      ['cow', 'huntable'],
      ['pig', 'has a name tag'],
      ['cow', 'huntable'],
      ['cow', 'is a baby'],
    ])
  })

  it('shows the breeding floor and follows the options', () => {
    const { scanner, tool: t } = tool()
    scanner.animals = [animal('cow', 3), animal('cow', 5), animal('cow', 8, { baby: true })]

    const kept = run(t)
    const free = run(t, { keep_breeders: false, allow_babies: true })

    expect(kept).toMatchObject({ ok: true, data: { species: [{ species: 'cow', huntable: 0 }] } })
    expect(free).toMatchObject({ ok: true, data: { species: [{ species: 'cow', huntable: 3 }] } })
  })

  it('shows at most 40 animals and says when it cut the list', () => {
    const { scanner, tool: t } = tool()
    scanner.animals = Array.from({ length: 45 }, (_, i) => animal('chicken', 2 + i * 0.1))

    const result = run(t)

    expect(result).toMatchObject({ ok: true, data: { truncated: true } })
    expect(((result.ok ? result.data : {}) as { animals: unknown[] }).animals).toHaveLength(40)
  })

  it('answers with nothing around', () => {
    expect(run(tool().tool)).toMatchObject({
      ok: true,
      data: { species: [], animals: [], truncated: false },
    })
  })
})

describe('SetFoodPolicyTool', () => {
  async function tool() {
    const store = new InMemoryStateStore()
    const policy = new FoodPolicy()
    const standing = new StandingInstructions()
    await policy.attach(store)
    await standing.attach(store)
    return { policy, standing, tool: new SetFoodPolicyTool(policy, standing) }
  }

  it('saves the policy and mirrors it as a standing instruction the briefing shows', async () => {
    const { policy, standing, tool: t } = await tool()

    const result = t.execute(t.inputSchema.parse({ policy: 'hunt_and_cook' }))

    expect(result).toEqual({ ok: true, data: { policy: 'hunt_and_cook' } })
    expect(policy.get()).toBe('hunt_and_cook')
    expect(standing.all().food_policy).toContain('hunts animals')
  })

  it('removes the standing instruction when going back to asking', async () => {
    const { policy, standing, tool: t } = await tool()
    t.execute(t.inputSchema.parse({ policy: 'stop' }))
    expect(standing.all().food_policy).toContain('cancels')

    t.execute(t.inputSchema.parse({ policy: 'ask' }))

    expect(policy.get()).toBe('ask')
    expect(standing.all()).not.toHaveProperty('food_policy')
  })

  it('fails without an active world', () => {
    const t = new SetFoodPolicyTool(new FoodPolicy(), new StandingInstructions())

    expect(t.execute(t.inputSchema.parse({ policy: 'stop' })).ok).toBe(false)
    expect(t.inputSchema.safeParse({ policy: 'sometimes' }).success).toBe(false)
  })
})
