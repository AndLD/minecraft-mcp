import { describe, expect, it } from '@jest/globals'
import { ok } from '../../../../src/core/result.js'
import type { SkillContext } from '../../../../src/core/skill.types.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import {
  TeleportToPlayerTool,
  TeleportToPositionTool,
} from '../../../../src/mcp/tools/teleport-tools.js'
import type { ToolContext } from '../../../../src/mcp/tool.types.js'
import type { TeleportSkill } from '../../../../src/skills/commands/teleport-skill.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'

const context: ToolContext = { signal: new AbortController().signal }

function setup() {
  const clock = new FakeClock(0)
  const tasks = new TaskManager({
    clock,
    scheduler: new FakeScheduler(clock),
    logger: new FakeLogger(),
  })
  const inputs: unknown[] = []
  const skill = {
    name: 'teleport',
    run: (input: unknown, _ctx: SkillContext) => {
      inputs.push(input)
      return Promise.resolve(ok('done'))
    },
  } as unknown as TeleportSkill
  return { inputs, skill, launcher: new TaskLauncher(tasks, clock) }
}

describe('teleport_to_player', () => {
  it('teleports to the owner by default', async () => {
    const s = setup()
    const tool = new TeleportToPlayerTool(s.skill, s.launcher, 'Andrey_Knight')

    const result = await tool.execute(tool.inputSchema.parse({}), context)

    expect(s.inputs).toEqual([{ target: { kind: 'player', name: 'Andrey_Knight' } }])
    expect(result).toMatchObject({ ok: true, data: { description: 'Teleport to Andrey_Knight' } })
  })

  it('teleports to the named player', async () => {
    const s = setup()
    const tool = new TeleportToPlayerTool(s.skill, s.launcher, 'Andrey_Knight')

    await tool.execute(tool.inputSchema.parse({ player: 'Steve' }), context)

    expect(s.inputs).toEqual([{ target: { kind: 'player', name: 'Steve' } }])
  })

  it('needs a player when no owner is configured', async () => {
    const s = setup()
    const tool = new TeleportToPlayerTool(s.skill, s.launcher, undefined)

    expect(await tool.execute(tool.inputSchema.parse({}), context)).toMatchObject({ ok: false })
    expect(s.inputs).toEqual([])
  })

  it('tells the agent to teleport only on request, and what it needs', () => {
    const tool = new TeleportToPlayerTool(setup().skill, setup().launcher, undefined)

    expect(tool.description).toContain('Only when the player asks')
    expect(tool.description).toContain('operator')
    expect(tool.description).toContain('no_permission')
  })
})

describe('teleport_to_position', () => {
  it('teleports to the coordinates', async () => {
    const s = setup()
    const tool = new TeleportToPositionTool(s.skill, s.launcher)

    const result = await tool.execute(tool.inputSchema.parse({ x: 10, y: 70, z: -4 }), context)

    expect(s.inputs).toEqual([{ target: { kind: 'position', position: { x: 10, y: 70, z: -4 } } }])
    expect(result).toMatchObject({ ok: true, data: { description: 'Teleport to 10, 70, -4' } })
  })

  it('refuses heights outside the world', () => {
    const tool = new TeleportToPositionTool(setup().skill, setup().launcher)

    expect(tool.inputSchema.safeParse({ x: 0, y: 400, z: 0 }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ x: 0, y: -80, z: 0 }).success).toBe(false)
    expect(tool.description).toContain('Only when the player asks')
  })
})
