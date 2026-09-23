import { describe, expect, it } from '@jest/globals'
import type { LookTarget } from '../../../../src/core/container.port.js'
import { ok } from '../../../../src/core/result.js'
import type { SkillContext } from '../../../../src/core/skill.types.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import { OpenDoorTool } from '../../../../src/mcp/tools/open-door-tool.js'
import type { ToolContext } from '../../../../src/mcp/tool.types.js'
import type { OpenDoorSkill } from '../../../../src/skills/movement/open-door-skill.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'

const context: ToolContext = { signal: new AbortController().signal }
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function setup(options: { hang?: boolean } = {}) {
  const clock = new FakeClock(0)
  const tasks = new TaskManager({ clock, scheduler: new FakeScheduler(clock), logger: new FakeLogger() })
  const launcher = new TaskLauncher(tasks, clock)
  const inputs: unknown[] = []
  const skill = {
    name: 'open_door',
    run: (input: unknown, _ctx: SkillContext) => {
      inputs.push(input)
      // For the resume-descriptor test: stays "running" long enough to read the task's resume field.
      if (options.hang === true) return new Promise<never>(() => undefined)
      return Promise.resolve(ok({ name: 'oak_door', wasOpen: false, walkedThrough: true, restored: true }))
    },
  } as unknown as OpenDoorSkill
  const look: { hit: { name: string; position: { x: number; y: number; z: number } } | undefined } = {
    hit: undefined,
  }
  const lookTarget: LookTarget = {
    blockLookedAt: () => (look.hit === undefined ? undefined : { ...look.hit, face: 'north' }),
  }
  return { tasks, inputs, launcher, skill, look, lookTarget }
}

describe('OpenDoorTool', () => {
  it('opens the door at a given position, with defaults for walk_through and restore', async () => {
    const s = setup()
    const tool = new OpenDoorTool(s.skill, s.launcher, s.lookTarget, 'Andrey_Knight')

    const result = await tool.execute(tool.inputSchema.parse({ at: { x: 1, y: 64, z: 0 } }), context)

    expect(result).toMatchObject({ ok: true, data: { status: 'succeeded' } })
    expect(s.inputs).toEqual([{ position: { x: 1, y: 64, z: 0 }, walkThrough: true, restore: true }])
  })

  it('threads walk_through and restore through to the skill', async () => {
    const s = setup()
    const tool = new OpenDoorTool(s.skill, s.launcher, s.lookTarget, 'Andrey_Knight')

    await tool.execute(
      tool.inputSchema.parse({ at: { x: 1, y: 64, z: 0 }, walk_through: false, restore: false }),
      context,
    )

    expect(s.inputs).toEqual([{ position: { x: 1, y: 64, z: 0 }, walkThrough: false, restore: false }])
  })

  it("resolves the position from the player's look when at is omitted", async () => {
    const s = setup()
    s.look.hit = { name: 'oak_door', position: { x: 1, y: 64, z: 0 } }
    const tool = new OpenDoorTool(s.skill, s.launcher, s.lookTarget, 'Andrey_Knight')

    const result = await tool.execute(tool.inputSchema.parse({}), context)

    expect(result.ok).toBe(true)
    expect(s.inputs).toEqual([{ position: { x: 1, y: 64, z: 0 }, walkThrough: true, restore: true }])
  })

  it('fails when no player is configured and no position is given', () => {
    const s = setup()
    const tool = new OpenDoorTool(s.skill, s.launcher, s.lookTarget, undefined)

    const result = tool.execute(tool.inputSchema.parse({}), context)

    expect(result).toEqual({
      ok: false,
      error: 'Say which player: no owner is configured, and none was given as for_player.',
    })
  })

  it('records the resolved position and options for resuming', async () => {
    const s = setup({ hang: true })
    const tool = new OpenDoorTool(s.skill, s.launcher, s.lookTarget, 'Andrey_Knight')

    void tool.execute(
      tool.inputSchema.parse({ at: { x: 1, y: 64, z: 0 }, restore: false, wait_seconds: 0 }),
      context,
    )
    await flush()

    expect(s.tasks.current()?.resume).toEqual({
      tool: 'open_door',
      arguments: { at: { x: 1, y: 64, z: 0 }, walk_through: true, restore: false },
    })
  })
})
