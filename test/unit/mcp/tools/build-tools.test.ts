import { describe, expect, it } from '@jest/globals'
import { ok } from '../../../../src/core/result.js'
import type { SkillContext } from '../../../../src/core/skill.types.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import {
  BuildTool,
  ListBlueprintsTool,
  PlaceBlockTool,
  PreviewBuildTool,
} from '../../../../src/mcp/tools/build-tools.js'
import type { ToolContext } from '../../../../src/mcp/tool.types.js'
import { BlueprintRegistry } from '../../../../src/skills/building/blueprint-registry.js'
import type { BuildSkill } from '../../../../src/skills/building/build-skill.js'
import {
  BoxProvider,
  FloorProvider,
} from '../../../../src/skills/building/providers/basic-providers.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'

const context: ToolContext = { signal: new AbortController().signal }

function setup(preview: unknown = { ok: true, value: { toPlace: 9 } }) {
  const clock = new FakeClock(0)
  const tasks = new TaskManager({
    clock,
    scheduler: new FakeScheduler(clock),
    logger: new FakeLogger(),
  })
  const inputs: unknown[] = []
  const skill = {
    name: 'build',
    run: (input: unknown, _ctx: SkillContext) => {
      inputs.push(input)
      return Promise.resolve(ok('done'))
    },
    preview: (input: unknown) => {
      inputs.push(input)
      return preview
    },
  } as unknown as BuildSkill
  return { inputs, skill, tasks, launcher: new TaskLauncher(tasks, clock) }
}

describe('build', () => {
  it('turns the arguments into a build request, and can be resumed with the same arguments', async () => {
    const s = setup()
    const tool = new BuildTool(s.skill, s.launcher)

    const result = await tool.execute(
      tool.inputSchema.parse({
        blueprint: 'box',
        params: { width: 5, depth: 5, height: 3 },
        origin: { x: 10, y: 64, z: -3 },
        clear_obstacles: true,
      }),
      context,
    )

    expect(s.inputs[0]).toEqual({
      blueprint: 'box',
      params: { width: 5, depth: 5, height: 3 },
      origin: { x: 10, y: 64, z: -3 },
      clearObstacles: true,
      fetchFromStorage: true,
      onInventoryFull: undefined,
    })
    expect(result).toMatchObject({ ok: true, data: { description: 'Build box' } })
    expect(s.tasks.get('task-1')?.resume).toEqual({
      tool: 'build',
      arguments: {
        blueprint: 'box',
        params: { width: 5, depth: 5, height: 3 },
        origin: { x: 10, y: 64, z: -3 },
        clear_obstacles: true,
        fetch_from_storage: true,
      },
    })
  })

  it('uses defaults: no origin, nothing cleared', async () => {
    const s = setup()
    const tool = new BuildTool(s.skill, s.launcher)

    await tool.execute(tool.inputSchema.parse({ blueprint: 'floor' }), context)

    expect(s.inputs[0]).toMatchObject({ params: {}, origin: undefined, clearObstacles: false })
  })

  it('rejects non-integer coordinates', () => {
    const tool = new BuildTool(setup().skill, setup().launcher)

    expect(
      tool.inputSchema.safeParse({ blueprint: 'floor', origin: { x: 1.5, y: 64, z: 0 } }).success,
    ).toBe(false)
  })
})

describe('preview_build', () => {
  it('returns the preview, changing nothing', () => {
    const s = setup()
    const tool = new PreviewBuildTool(s.skill)

    expect(tool.execute(tool.inputSchema.parse({ blueprint: 'floor' }))).toEqual({
      ok: true,
      data: { toPlace: 9 },
    })
    expect(s.inputs[0]).toMatchObject({ fetchFromStorage: false })
  })

  it('passes on a failure with its reason', () => {
    const s = setup({
      ok: false,
      error: { reason: 'invalid_params', message: 'Wrong parameters.' },
    })
    const tool = new PreviewBuildTool(s.skill)

    expect(tool.execute(tool.inputSchema.parse({ blueprint: 'floor' }))).toEqual({
      ok: false,
      error: 'Wrong parameters. (reason: invalid_params)',
    })
  })
})

describe('list_blueprints', () => {
  it('lists the registry', () => {
    const registry = new BlueprintRegistry()
      .register(new BoxProvider())
      .register(new FloorProvider())
    const tool = new ListBlueprintsTool(registry)

    const result = tool.execute()

    expect(result).toMatchObject({
      ok: true,
      data: { blueprints: [{ name: 'box' }, { name: 'floor' }] },
    })
  })
})

describe('place_block', () => {
  it('places one block at the coordinates, through the block blueprint', async () => {
    const s = setup()
    const tool = new PlaceBlockTool(s.skill, s.launcher)

    const result = await tool.execute(
      tool.inputSchema.parse({ block: 'torch', x: 3, y: 65, z: -2 }),
      context,
    )

    expect(s.inputs[0]).toEqual({
      blueprint: 'block',
      params: { block: 'torch' },
      origin: { x: 3, y: 65, z: -2 },
      clearObstacles: false,
      fetchFromStorage: false,
    })
    expect(result).toMatchObject({ ok: true, data: { description: 'Place torch at 3, 65, -2' } })
  })
})
