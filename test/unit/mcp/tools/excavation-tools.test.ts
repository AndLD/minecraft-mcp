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
import type { LookTarget } from '../../../../src/core/container.port.js'
import type { ExcavateSkill } from '../../../../src/skills/excavation/excavate-skill.js'
import { ExcavationRegistry } from '../../../../src/skills/excavation/excavation-registry.js'
import {
  PitProvider,
  QuarryProvider,
} from '../../../../src/skills/excavation/providers/dig-down.js'
import { WallTarget, type WallResolveInput } from '../../../../src/skills/excavation/wall-target.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeBlockScanner, FakeEntityScanner } from '../../../fakes/fake-ports.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'

const context: ToolContext = { signal: new AbortController().signal }

/**
 * A real WallTarget wired to fakes: by default nobody is looking at anything, so it only matters for shape: room,
 * where a test sets `look.hit` (and, for the floor, `blocks.solid`) to control what is resolved.
 */
function stubWallTarget() {
  const calls: WallResolveInput[] = []
  const look: {
    hit:
      | {
          name: string
          position: { x: number; y: number; z: number }
          face: 'top' | 'bottom' | 'north' | 'south' | 'east' | 'west'
        }
      | undefined
  } = { hit: undefined }
  const lookTarget: LookTarget = { blockLookedAt: () => look.hit }
  const blocks = new FakeBlockScanner()
  const entities = new FakeEntityScanner()
  const real = new WallTarget(lookTarget, blocks, entities)
  return {
    calls,
    look,
    blocks,
    entities,
    wallTarget: { resolve: (input: WallResolveInput) => (calls.push(input), real.resolve(input)) },
  }
}

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
  return {
    inputs,
    skill,
    tasks,
    launcher: new TaskLauncher(tasks, clock),
    ...stubWallTarget(),
  }
}

describe('excavate', () => {
  it('turns the arguments into a request and can be resumed with them', async () => {
    const s = setup()
    const tool = new ExcavateTool(s.skill, s.launcher, s.wallTarget, 'Andrey_Knight')

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
      spoilPolicy: 'storage',
      onInventoryFull: 'offload_and_return',
      fallingBlocks: 'stop',
    })
    expect(result).toMatchObject({ ok: true, data: { description: 'Excavate tunnel' } })
    expect(s.tasks.get('task-1')?.resume).toEqual({
      tool: 'excavate',
      arguments: {
        shape: 'tunnel',
        params: { direction: 'north', length: 50, height: 5 },
        origin: { x: 10, y: -55, z: 3 },
        fetch_from_storage: true,
        spoil_policy: 'storage',
        falling_blocks: 'stop',
      },
    })
  })

  it('passes falling_blocks: clear on to the skill and keeps it for a resume', async () => {
    const s = setup()
    const tool = new ExcavateTool(s.skill, s.launcher, s.wallTarget, undefined)

    await tool.execute(
      tool.inputSchema.parse({
        shape: 'staircase_down',
        params: { direction: 'north', depth: 10 },
        falling_blocks: 'clear',
      }),
      context,
    )

    expect(s.inputs[0]).toMatchObject({ fallingBlocks: 'clear' })
    expect(s.tasks.get('task-1')?.resume).toMatchObject({
      arguments: { falling_blocks: 'clear' },
    })
  })

  it('uses defaults: no origin, fetching allowed', async () => {
    const s = setup()
    const tool = new ExcavateTool(s.skill, s.launcher, s.wallTarget, 'Andrey_Knight')

    await tool.execute(tool.inputSchema.parse({ shape: 'pit' }), context)

    expect(s.inputs[0]).toMatchObject({ params: {}, origin: undefined, fetchFromStorage: true })
    expect(s.calls).toEqual([]) // the wall is only read for shape: room
  })

  it('tells the agent about the hazard rule and the reasons a chain ends', () => {
    const s = setup()
    const tool = new ExcavateTool(s.skill, s.launcher, s.wallTarget, 'Andrey_Knight')

    expect(tool.description).toContain('lava or water')
    expect(tool.description).toContain('hit_lava')
    expect(tool.description).toContain('cave_breakthrough')
    expect(tool.description).toContain('no_torches')
  })

  it('resolves a room by the wall the player looks at, and stores the resolved wall in the resume', async () => {
    const s = setup()
    s.wallTarget.resolve = (input) => {
      s.calls.push(input)
      return { ok: true, origin: { x: 4, y: 63, z: 9 }, direction: 'south' }
    }
    const tool = new ExcavateTool(s.skill, s.launcher, s.wallTarget, 'Andrey_Knight')

    await tool.execute(
      tool.inputSchema.parse({ shape: 'room', params: { width: 3, length: 4 } }),
      context,
    )

    expect(s.calls).toEqual([{ player: 'Andrey_Knight', at: undefined, direction: undefined }])
    expect(s.inputs[0]).toMatchObject({
      origin: { x: 4, y: 63, z: 9 },
      params: { width: 3, length: 4, direction: 'south' },
    })
    expect(s.tasks.get('task-1')?.resume).toMatchObject({
      arguments: {
        origin: { x: 4, y: 63, z: 9 },
        params: { width: 3, length: 4, direction: 'south' },
      },
    })
  })

  it('fails cleanly when there is no wall to resolve and nobody to ask', async () => {
    const s = setup()
    const tool = new ExcavateTool(s.skill, s.launcher, s.wallTarget, undefined)

    const result = await tool.execute(
      tool.inputSchema.parse({ shape: 'room', params: { width: 3, length: 4 } }),
      context,
    )

    expect(result).toEqual({ ok: false, error: 'Say which player: no owner is configured, and none was given as for_player.' })
  })
})

describe('preview_excavation', () => {
  it('returns the preview without starting anything', () => {
    const s = setup()
    const tool = new PreviewExcavationTool(s.skill, s.wallTarget, 'Andrey_Knight')

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
    const tool = new PreviewExcavationTool(s.skill, s.wallTarget, 'Andrey_Knight')

    expect(tool.execute(tool.inputSchema.parse({ shape: 'pit' }))).toEqual({
      ok: false,
      error: 'Wrong parameters. (reason: invalid_params)',
    })
  })

  it('reports why a room cannot be resolved, without calling the skill', () => {
    const s = setup()
    s.wallTarget.resolve = () => ({
      ok: false,
      reason: 'not_a_wall',
      message: 'That is the top, not a wall.',
    })
    const tool = new PreviewExcavationTool(s.skill, s.wallTarget, 'Andrey_Knight')

    const result = tool.execute(
      tool.inputSchema.parse({ shape: 'room', params: { width: 3, length: 4 } }),
    )

    expect(result).toEqual({ ok: false, error: 'That is the top, not a wall.' })
    expect(s.inputs).toEqual([])
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
