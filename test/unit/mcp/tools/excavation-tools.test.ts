import { describe, expect, it } from '@jest/globals'
import { ok } from '../../../../src/core/result.js'
import type { SkillContext } from '../../../../src/core/skill.types.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import {
  ExcavateTool,
  ListExcavationsTool,
  PreviewExcavationTool,
} from '../../../../src/mcp/tools/excavation-tools.js'
import type { ToolContext } from '../../../../src/mcp/tool.types.js'
import type { ExcavateSkill } from '../../../../src/skills/excavation/excavate-skill.js'
import { ExcavationRegistry } from '../../../../src/skills/excavation/excavation-registry.js'
import {
  PitProvider,
  QuarryProvider,
} from '../../../../src/skills/excavation/providers/dig-down.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'

const context: ToolContext = { signal: new AbortController().signal }

function setup(preview: unknown = { ok: true, value: { blocks: 18 } }) {
  const clock = new FakeClock(0)
  const tasks = new TaskManager({
    clock,
    scheduler: new FakeScheduler(clock),
    logger: new FakeLogger(),
  })
  const inputs: unknown[] = []
  const skill = {
    name: 'excavate',
    run: (input: unknown, _ctx: SkillContext) => {
      inputs.push(input)
      return Promise.resolve(ok('done'))
    },
    preview: (input: unknown) => {
      inputs.push(input)
      return preview
    },
  } as unknown as ExcavateSkill
  return { inputs, skill, tasks, launcher: new TaskLauncher(tasks, clock) }
}

describe('excavate', () => {
  it('turns the arguments into a request and can be resumed with them', async () => {
    const s = setup()
    const tool = new ExcavateTool(s.skill, s.launcher)

    const result = await tool.execute(
      tool.inputSchema.parse({
        shape: 'tunnel',
        params: { direction: 'north', length: 50, height: 5 },
        origin: { x: 10, y: -55, z: 3 },
        on_inventory_full: 'offload_and_return',
      }),
      context,
    )

    expect(s.inputs[0]).toEqual({
      shape: 'tunnel',
      params: { direction: 'north', length: 50, height: 5 },
      origin: { x: 10, y: -55, z: 3 },
      fetchFromStorage: true,
      onInventoryFull: 'offload_and_return',
    })
    expect(result).toMatchObject({ ok: true, data: { description: 'Excavate tunnel' } })
    expect(s.tasks.get('task-1')?.resume).toEqual({
      tool: 'excavate',
      arguments: {
        shape: 'tunnel',
        params: { direction: 'north', length: 50, height: 5 },
        origin: { x: 10, y: -55, z: 3 },
        fetch_from_storage: true,
      },
    })
  })

  it('uses defaults: no origin, fetching allowed', async () => {
    const s = setup()
    const tool = new ExcavateTool(s.skill, s.launcher)

    await tool.execute(tool.inputSchema.parse({ shape: 'pit' }), context)

    expect(s.inputs[0]).toMatchObject({ params: {}, origin: undefined, fetchFromStorage: true })
  })

  it('tells the agent about the hazard rule and the reasons a chain ends', () => {
    const tool = new ExcavateTool(setup().skill, setup().launcher)

    expect(tool.description).toContain('lava or water')
    expect(tool.description).toContain('hit_lava')
    expect(tool.description).toContain('cave_breakthrough')
    expect(tool.description).toContain('no_torches')
  })
})

describe('preview_excavation', () => {
  it('returns the preview without starting anything', () => {
    const s = setup()
    const tool = new PreviewExcavationTool(s.skill)

    expect(tool.execute(tool.inputSchema.parse({ shape: 'pit', params: { width: 3 } }))).toEqual({
      ok: true,
      data: { blocks: 18 },
    })
    expect(s.tasks.current()).toBeUndefined()
  })

  it('passes on a failure with its reason', () => {
    const s = setup({
      ok: false,
      error: { reason: 'invalid_params', message: 'Wrong parameters.' },
    })
    const tool = new PreviewExcavationTool(s.skill)

    expect(tool.execute(tool.inputSchema.parse({ shape: 'pit' }))).toEqual({
      ok: false,
      error: 'Wrong parameters. (reason: invalid_params)',
    })
  })
})

describe('list_excavations', () => {
  it('lists the shapes with their parameters', () => {
    const registry = new ExcavationRegistry()
      .register(new PitProvider())
      .register(new QuarryProvider())
    const tool = new ListExcavationsTool(registry)

    expect(tool.execute()).toMatchObject({
      ok: true,
      data: { shapes: [{ name: 'pit' }, { name: 'quarry' }] },
    })
  })
})
