import { describe, expect, it } from '@jest/globals'
import type { Clock } from '../../../../src/core/clock.port.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import { FollowPlayerTool } from '../../../../src/mcp/tools/follow-player-tool.js'
import { GoToTool } from '../../../../src/mcp/tools/goto-tool.js'
import {
  CancelTaskTool,
  GetTaskStatusTool,
  StopTool,
} from '../../../../src/mcp/tools/task-tools.js'
import type { ToolContext } from '../../../../src/mcp/tool.types.js'
import { BlockFinder } from '../../../../src/perception/block-finder.js'
import { FollowPlayerSkill } from '../../../../src/skills/movement/follow-player-skill.js'
import { GoToSkill } from '../../../../src/skills/movement/goto-skill.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeBlockScanner, FakeNavigator } from '../../../fakes/fake-ports.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'

const context = (signal: AbortSignal = new AbortController().signal): ToolContext => ({ signal })
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function setup() {
  const clock: Clock & FakeClock = new FakeClock(Date.UTC(2026, 8, 19, 12, 0, 0))
  const scheduler = new FakeScheduler(clock)
  const tasks = new TaskManager({ clock, scheduler, logger: new FakeLogger() })
  const navigator = new FakeNavigator()
  const scanner = new FakeBlockScanner()
  const launcher = new TaskLauncher(tasks, clock)
  const goto = new GoToTool(new GoToSkill(navigator, new BlockFinder(scanner)), launcher)
  const follow = new FollowPlayerTool(new FollowPlayerSkill(navigator), launcher, 'Andrey_Knight')
  return { clock, scheduler, tasks, navigator, scanner, goto, follow }
}

describe('GoToTool', () => {
  it('validates that exactly one target form is given', () => {
    const { goto } = setup()
    const valid = (input: unknown): boolean => goto.inputSchema.safeParse(input).success

    expect(valid({ x: 1, y: 2, z: 3 })).toBe(true)
    expect(valid({ player: 'A' })).toBe(true)
    expect(valid({ block: 'oak_log' })).toBe(true)
    expect(valid({})).toBe(false)
    expect(valid({ x: 1, y: 2 })).toBe(false)
    expect(valid({ x: 1, y: 2, z: 3, player: 'A' })).toBe(false)
    expect(valid({ player: 'A', block: 'oak_log' })).toBe(false)
  })

  it('applies defaults', () => {
    const parsed = setup().goto.inputSchema.parse({ player: 'A' })

    expect(parsed).toMatchObject({ within: 2, max_distance: 32, replace: false })
    expect(parsed.wait_seconds).toBeUndefined()
  })

  it('walks to coordinates and answers with the finished task', async () => {
    const { goto, navigator } = setup()

    const running = goto.execute(goto.inputSchema.parse({ x: 10, y: 64, z: 5 }), context())
    await flush()
    navigator.arrive({ x: 10, y: 64, z: 5 })

    expect(await running).toMatchObject({
      ok: true,
      data: {
        taskId: 'task-1',
        name: 'goto',
        description: 'Go to 10, 64, 5',
        status: 'succeeded',
        result: { arrivedAt: { x: 10, y: 64, z: 5 } },
      },
    })
  })

  it('walks to a player', async () => {
    const { goto, navigator } = setup()

    const running = goto.execute(
      goto.inputSchema.parse({ player: 'Andrey_Knight', within: 3 }),
      context(),
    )
    await flush()
    navigator.arrive({ x: 1, y: 64, z: 1 })

    expect(await running).toMatchObject({
      ok: true,
      data: { description: 'Go to player Andrey_Knight' },
    })
    expect(navigator.calls[0]).toEqual({ kind: 'player', target: 'Andrey_Knight', within: 3 })
  })

  it('walks to the nearest block', async () => {
    const { goto, navigator, scanner } = setup()
    scanner.blocks = [{ name: 'oak_log', position: { x: 4, y: 64, z: 4 }, distance: 5 }]

    const running = goto.execute(goto.inputSchema.parse({ block: 'oak_log' }), context())
    await flush()
    navigator.arrive({ x: 3, y: 64, z: 3 })

    expect(await running).toMatchObject({
      ok: true,
      data: { description: 'Go to the nearest oak_log' },
    })
  })

  it('answers "running" when the wait budget is used up, and the task keeps going', async () => {
    const { goto, navigator, scheduler, tasks } = setup()

    const running = goto.execute(
      goto.inputSchema.parse({ x: 500, y: 64, z: 0, wait_seconds: 10 }),
      context(),
    )
    await flush()
    scheduler.advance(10_000)
    const answer = await running

    expect(answer).toMatchObject({ ok: true, data: { status: 'running', taskId: 'task-1' } })
    navigator.arrive({ x: 500, y: 64, z: 0 })
    await flush()
    expect(tasks.get('task-1')?.status).toBe('succeeded')
  })

  it('reports a failed trip with its reason', async () => {
    const { goto, navigator } = setup()

    const running = goto.execute(goto.inputSchema.parse({ x: 1, y: 2, z: 3 }), context())
    await flush()
    navigator.fail({ reason: 'unreachable', message: 'No path.' })

    expect(await running).toEqual({ ok: false, error: 'No path. (reason: unreachable)' })
  })

  it('refuses to start while another task runs, unless told to replace it', async () => {
    const { goto, navigator, tasks } = setup()
    void goto.execute(goto.inputSchema.parse({ x: 1, y: 2, z: 3, wait_seconds: 0 }), context())
    await flush()

    const refused = await goto.execute(
      goto.inputSchema.parse({ x: 9, y: 9, z: 9, wait_seconds: 0 }),
      context(),
    )
    const replaced = await goto.execute(
      goto.inputSchema.parse({ x: 9, y: 9, z: 9, wait_seconds: 0, replace: true }),
      context(),
    )

    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.error).toContain('still running')
    expect(replaced).toMatchObject({ ok: true, data: { taskId: 'task-2', status: 'running' } })
    expect(tasks.get('task-1')?.status).toBe('cancelled')
    expect(navigator.calls).toHaveLength(2)
  })

  it('reports a cancelled trip', async () => {
    const { goto, tasks } = setup()

    const running = goto.execute(goto.inputSchema.parse({ x: 1, y: 2, z: 3 }), context())
    await flush()
    await tasks.cancel()

    expect(await running).toEqual({
      ok: false,
      error: 'The task was cancelled before it finished.',
    })
  })

  it('rejects an invalid target at execution time as well', () => {
    const { goto } = setup()

    const result = goto.execute(
      { x: 1, max_distance: 32, within: 2, close_doors: true, replace: false },
      context(),
    )

    expect(result).toEqual({
      ok: false,
      error: 'Give exactly one target: x, y and z together, or player, or block.',
    })
  })

  it('describes an unknown task failure generically', async () => {
    const { goto, navigator } = setup()

    const running = goto.execute(goto.inputSchema.parse({ x: 1, y: 2, z: 3 }), context())
    await flush()
    navigator.fail({ reason: 'stuck', message: 'The bot has not moved.' })

    expect((await running).ok).toBe(false)
  })
})

describe('the reflex gate', () => {
  it('refuses to start a task while a survival reflex is acting, and says why', async () => {
    const { clock, tasks, navigator, scanner } = setup()
    const gate = { activeReflex: (): string | undefined => 'threat_response' }
    const goto = new GoToTool(
      new GoToSkill(navigator, new BlockFinder(scanner)),
      new TaskLauncher(tasks, clock, gate),
    )

    const result = await goto.execute(goto.inputSchema.parse({ x: 1, y: 2, z: 3 }), context())

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain('threat_response')
    expect(tasks.current()).toBeUndefined()
  })

  it('starts tasks normally when no reflex is acting', async () => {
    const { clock, tasks, navigator, scanner } = setup()
    const gate = { activeReflex: (): string | undefined => undefined }
    const goto = new GoToTool(
      new GoToSkill(navigator, new BlockFinder(scanner)),
      new TaskLauncher(tasks, clock, gate),
    )

    void goto.execute(goto.inputSchema.parse({ x: 1, y: 2, z: 3, wait_seconds: 0 }), context())
    await flush()

    expect(tasks.current()?.name).toBe('goto')
  })
})

describe('resume descriptors', () => {
  it('goto records how to start the same trip again, without the wait and replace options', async () => {
    const { goto, tasks } = setup()

    void goto.execute(
      goto.inputSchema.parse({ x: 10, y: 64, z: 5, within: 3, wait_seconds: 0, replace: true }),
      context(),
    )
    await flush()

    expect(tasks.current()?.resume).toEqual({
      tool: 'goto',
      arguments: { x: 10, y: 64, z: 5, within: 3, max_distance: 32, close_doors: true },
    })
  })

  it('goto by player or block keeps that target', async () => {
    const { goto, tasks } = setup()

    void goto.execute(
      goto.inputSchema.parse({ player: 'Andrey_Knight', wait_seconds: 0 }),
      context(),
    )
    await flush()

    expect(tasks.current()?.resume).toMatchObject({
      tool: 'goto',
      arguments: { player: 'Andrey_Knight' },
    })
  })

  it('follow_player records the player and distance', async () => {
    const { follow, tasks } = setup()

    void follow.execute(follow.inputSchema.parse({ distance: 4, wait_seconds: 0 }), context())
    await flush()

    expect(tasks.current()?.resume).toEqual({
      tool: 'follow_player',
      arguments: { player: 'Andrey_Knight', distance: 4 },
    })
  })
})

describe('FollowPlayerTool', () => {
  it('starts following the owner by default and answers quickly with "running"', async () => {
    const { follow, navigator, scheduler } = setup()

    const running = follow.execute(follow.inputSchema.parse({}), context())
    await flush()
    scheduler.advance(2000)

    expect(await running).toMatchObject({
      ok: true,
      data: { name: 'follow_player', status: 'running', description: 'Follow Andrey_Knight' },
    })
    expect(navigator.calls[0]).toEqual({ kind: 'follow', target: 'Andrey_Knight', within: 3 })
  })

  it('follows a named player at the given distance', async () => {
    const { follow, navigator, scheduler } = setup()

    const running = follow.execute(
      follow.inputSchema.parse({ player: 'Alex', distance: 5 }),
      context(),
    )
    await flush()
    scheduler.advance(2000)
    await running

    expect(navigator.calls[0]).toEqual({ kind: 'follow', target: 'Alex', within: 5 })
  })

  it('needs a player when no owner is configured', () => {
    const { tasks, navigator, clock } = setup()
    const tool = new FollowPlayerTool(
      new FollowPlayerSkill(navigator),
      new TaskLauncher(tasks, clock),
      undefined,
    )

    expect(tool.execute(tool.inputSchema.parse({}), context())).toEqual({
      ok: false,
      error: 'Say which player to follow: no owner is configured.',
    })
  })

  it('validates the distance range', () => {
    const { follow } = setup()

    expect(follow.inputSchema.safeParse({ distance: 0 }).success).toBe(false)
    expect(follow.inputSchema.safeParse({ distance: 11 }).success).toBe(false)
  })
})

describe('task tools', () => {
  async function withRunningGoto() {
    const context1 = setup()
    void context1.goto.execute(
      context1.goto.inputSchema.parse({ x: 1, y: 2, z: 3, wait_seconds: 0 }),
      context(),
    )
    await flush()
    return context1
  }

  it('get_task_status reports nothing before any task ran', () => {
    const { tasks, clock } = setup()

    expect(new GetTaskStatusTool(tasks, clock).execute({})).toEqual({
      ok: true,
      data: { task: null },
    })
  })

  it('get_task_status reports the running task, with progress', async () => {
    const { tasks, clock, navigator } = await withRunningGoto()
    const original = tasks.current()
    expect(original?.status).toBe('running')
    navigator.arrive({ x: 1, y: 2, z: 3 })
    await flush()

    const status = new GetTaskStatusTool(tasks, clock).execute({})

    expect(status).toMatchObject({
      ok: true,
      data: { task: { taskId: 'task-1', status: 'succeeded', elapsedSeconds: 0 } },
    })
  })

  it('get_task_status looks tasks up by id, and rejects unknown ids', async () => {
    const { tasks, clock } = await withRunningGoto()
    const tool = new GetTaskStatusTool(tasks, clock)

    expect(tool.execute({ task_id: 'task-1' })).toMatchObject({
      ok: true,
      data: { task: { taskId: 'task-1' } },
    })
    expect(tool.execute({ task_id: 'task-9' })).toEqual({
      ok: false,
      error: 'Unknown task: task-9',
    })
  })

  it('cancel_task cancels the running task and reports it', async () => {
    const { tasks, clock } = await withRunningGoto()

    const result = await new CancelTaskTool(tasks, clock).execute({})

    expect(result).toMatchObject({
      ok: true,
      data: { task: { taskId: 'task-1', status: 'cancelled' } },
    })
  })

  it('cancel_task with an unknown id fails, and with nothing running reports null', async () => {
    const { tasks, clock } = setup()
    const tool = new CancelTaskTool(tasks, clock)

    expect(await tool.execute({ task_id: 'task-9' })).toEqual({
      ok: false,
      error: 'Unknown task: task-9',
    })
    expect(await tool.execute({})).toEqual({ ok: true, data: { task: null } })
  })

  it('stop cancels whatever runs, and is safe when nothing does', async () => {
    const { tasks, clock } = await withRunningGoto()
    const stop = new StopTool(tasks, clock)

    expect(await stop.execute()).toMatchObject({
      ok: true,
      data: { stopped: true, task: { status: 'cancelled' } },
    })
    expect(await stop.execute()).toEqual({ ok: true, data: { stopped: false, task: null } })
  })
})
