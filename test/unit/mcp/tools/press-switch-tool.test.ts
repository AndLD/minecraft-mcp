import { describe, expect, it } from '@jest/globals'
import type { LookTarget } from '../../../../src/core/container.port.js'
import type { DoorAccess, DoorFailure, DoorState } from '../../../../src/core/door.port.js'
import { ok, type Result } from '../../../../src/core/result.js'
import type { SwitchAccess, SwitchFailure, SwitchState } from '../../../../src/core/switch.port.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import { PressSwitchTool } from '../../../../src/mcp/tools/press-switch-tool.js'
import type { ToolContext } from '../../../../src/mcp/tool.types.js'
import { PressSwitchSkill } from '../../../../src/skills/movement/press-switch-skill.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeBlockScanner, FakeNavigator } from '../../../fakes/fake-ports.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'

const key = (p: { x: number; y: number; z: number }): string => `${String(p.x)},${String(p.y)},${String(p.z)}`
const context: ToolContext = { signal: new AbortController().signal }
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

class FakeSwitchAccess implements SwitchAccess {
  readonly pressed: { x: number; y: number; z: number }[] = []
  stateAt(): SwitchState | undefined {
    return undefined
  }
  press(position: { x: number; y: number; z: number }): Promise<Result<void, SwitchFailure>> {
    this.pressed.push(position)
    return Promise.resolve(ok(undefined))
  }
}

class FakeDoorAccess implements DoorAccess {
  stateAt(): DoorState | undefined {
    return undefined
  }
  toggle(): Promise<Result<void, DoorFailure>> {
    return Promise.resolve(ok(undefined))
  }
}

function setup() {
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const tasks = new TaskManager({ clock, scheduler, logger: new FakeLogger() })
  const launcher = new TaskLauncher(tasks, clock)
  const blocks = new FakeBlockScanner()
  blocks.blockNames.set(key({ x: 1, y: 64, z: 0 }), 'lever')
  const switches = new FakeSwitchAccess()
  const doors = new FakeDoorAccess()
  const navigator = new FakeNavigator()
  const skill = new PressSwitchSkill({ blocks, switches, doors, navigator })
  const look: { hit: { name: string; position: { x: number; y: number; z: number } } | undefined } = {
    hit: undefined,
  }
  const lookTarget: LookTarget = { blockLookedAt: () => (look.hit === undefined ? undefined : { ...look.hit, face: 'north' }) }
  return { tasks, scheduler, launcher, blocks, switches, navigator, skill, look, lookTarget }
}

describe('PressSwitchTool', () => {
  it('presses the switch at a given position', async () => {
    const s = setup()
    const tool = new PressSwitchTool(s.skill, s.launcher, s.lookTarget, 'Andrey_Knight')

    const running = tool.execute(tool.inputSchema.parse({ at: { x: 1, y: 64, z: 0 } }), context)
    await flush()
    s.navigator.arrive({ x: 1, y: 64, z: 0 })

    expect(await running).toMatchObject({ ok: true, data: { status: 'succeeded' } })
    expect(s.switches.pressed).toEqual([{ x: 1, y: 64, z: 0 }])
  })

  it('resolves the position from the player\'s look when at is omitted', async () => {
    const s = setup()
    s.look.hit = { name: 'lever', position: { x: 1, y: 64, z: 0 } }
    const tool = new PressSwitchTool(s.skill, s.launcher, s.lookTarget, 'Andrey_Knight')

    const running = tool.execute(tool.inputSchema.parse({}), context)
    await flush()
    s.navigator.arrive({ x: 1, y: 64, z: 0 })

    expect((await running).ok).toBe(true)
    expect(s.navigator.calls[0]).toMatchObject({ target: { x: 1, y: 64, z: 0 } })
  })

  it('fails when no player is configured and no position is given', () => {
    const s = setup()
    const tool = new PressSwitchTool(s.skill, s.launcher, s.lookTarget, undefined)

    const result = tool.execute(tool.inputSchema.parse({}), context)

    expect(result).toEqual({
      ok: false,
      error: 'Say which player: no owner is configured, and none was given as for_player.',
    })
  })

  it('fails when the player is not looking at anything', async () => {
    const s = setup()
    const tool = new PressSwitchTool(s.skill, s.launcher, s.lookTarget, 'Andrey_Knight')

    const result = await tool.execute(tool.inputSchema.parse({}), context)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain('not looking at any block')
  })

  it('records the resolved position for resuming', async () => {
    const s = setup()
    const tool = new PressSwitchTool(s.skill, s.launcher, s.lookTarget, 'Andrey_Knight')

    void tool.execute(
      tool.inputSchema.parse({ at: { x: 1, y: 64, z: 0 }, wait_seconds: 0 }),
      context,
    )
    await flush()

    expect(s.tasks.current()?.resume).toEqual({
      tool: 'press_switch',
      arguments: { at: { x: 1, y: 64, z: 0 } },
    })
  })
})
