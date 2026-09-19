import { describe, expect, it } from '@jest/globals'
import { err } from '../../../../src/core/result.js'
import {
  DiscardInterruptedTaskTool,
  ResumeInterruptedTaskTool,
} from '../../../../src/mcp/tools/journal-tools.js'
import {
  ForgetTool,
  GetRecentHistoryTool,
  RecallTool,
  RememberTool,
  RemoveStandingInstructionTool,
  SetStandingInstructionTool,
} from '../../../../src/mcp/tools/memory-tools.js'
import {
  GetSessionBriefingTool,
  ListWorldsTool,
  SetWorldProfileTool,
} from '../../../../src/mcp/tools/world-tools.js'
import type { ToolContext } from '../../../../src/mcp/tool.types.js'
import { SessionService } from '../../../../src/session/session-service.js'
import { FakeConnection, FakeLanDiscovery } from '../../../fakes/fake-ports.js'
import { buildStateStack, FakeWorldIdentifier, SEED_A } from '../../../fakes/state-fakes.js'
import { buildConfig } from '../../../fakes/test-config.js'

const context: ToolContext = { signal: new AbortController().signal }

async function withWorld() {
  const stack = buildStateStack()
  await stack.worldState.open(SEED_A)
  return stack
}

function interruptedGoto(stack: Awaited<ReturnType<typeof withWorld>>, withResume = true) {
  stack.tasks.start({
    name: 'goto',
    description: 'Go to 10, 64, 5',
    ...(withResume
      ? { resume: { tool: 'goto', arguments: { x: 10, y: 64, z: 5, within: 2 } } }
      : {}),
    run: (ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          resolve(err({ reason: 'aborted', message: '' }))
        })
      }),
  })
  return stack.tasks.cancel(undefined, 'disconnected')
}

describe('world tools', () => {
  it('get_session_briefing returns the briefing', async () => {
    const stack = await withWorld()

    expect(new GetSessionBriefingTool(stack.briefing).execute()).toMatchObject({
      ok: true,
      data: { world: { profile: 'survival' } },
    })
  })

  it('list_worlds lists the profiles and which is active', async () => {
    const stack = await withWorld()

    expect(await new ListWorldsTool(stack.worldState).execute()).toEqual({
      ok: true,
      data: {
        active: 'survival',
        worlds: [
          {
            profile: 'survival',
            worldName: 'Survival',
            createdAt: '2026-09-19T12:00:00.000Z',
            lastConnectedAt: '2026-09-19T12:00:00.000Z',
          },
        ],
      },
    })
  })

  it('list_worlds reports no active world after closing', async () => {
    const stack = await withWorld()
    await stack.worldState.close()

    expect(await new ListWorldsTool(stack.worldState).execute()).toMatchObject({
      data: { active: null },
    })
  })

  describe('set_world_profile', () => {
    function setup() {
      const stack = buildStateStack()
      const connection = new FakeConnection()
      const identifier = new FakeWorldIdentifier()
      identifier.fingerprint = { seed: null, worldName: null, spawn: null }
      const session = new SessionService({
        config: buildConfig({ port: 25565 }),
        connection,
        lanDiscovery: new FakeLanDiscovery(),
        logger: stack.logger,
        identifier,
        worldState: stack.worldState,
      })
      return { stack, session, connection, tool: new SetWorldProfileTool(session, stack.briefing) }
    }

    it('names the connected world and returns the new briefing', async () => {
      const { session, tool } = setup()
      await session.connect()

      const result = await tool.execute({ name: 'Survival One' })

      expect(result).toMatchObject({
        ok: true,
        data: { profile: 'survival-one', briefing: { world: { profile: 'survival-one' } } },
      })
    })

    it('fails when not connected or when the name is unusable', async () => {
      const { session, tool, connection } = setup()
      expect((await tool.execute({ name: 'x' })).ok).toBe(false)
      await session.connect()
      connection.state = 'connected'

      const result = await tool.execute({ name: '///' })

      expect(result).toEqual({
        ok: false,
        error: '"///" is not a usable profile name: use letters or digits.',
      })
    })
  })
})

describe('journal tools', () => {
  it('resume_interrupted_task restarts the task with the saved arguments and marks the job resumed', async () => {
    const stack = await withWorld()
    await interruptedGoto(stack)
    const invoked: { name: string; args: unknown }[] = []
    const tool = new ResumeInterruptedTaskTool(stack.journal, (name, args) => {
      invoked.push({ name, args })
      return Promise.resolve({ ok: true as const, data: { status: 'running' } })
    })

    const result = await tool.execute({ id: 'job-1', wait_seconds: 5 }, context)

    expect(invoked).toEqual([
      { name: 'goto', args: { x: 10, y: 64, z: 5, within: 2, wait_seconds: 5 } },
    ])
    expect(result).toEqual({ ok: true, data: { resumed: 'job-1', task: { status: 'running' } } })
    expect(stack.journal.get('job-1')?.status).toBe('resumed')
  })

  it('leaves the job interrupted when the tool cannot start it', async () => {
    const stack = await withWorld()
    await interruptedGoto(stack)
    const tool = new ResumeInterruptedTaskTool(stack.journal, () =>
      Promise.resolve({ ok: false as const, error: 'Task task-2 is still running.' }),
    )

    const result = await tool.execute({ id: 'job-1' }, context)

    expect(result).toEqual({ ok: false, error: 'Task task-2 is still running.' })
    expect(stack.journal.get('job-1')?.status).toBe('interrupted')
  })

  it('refuses unknown jobs, jobs that are not interrupted, and jobs with no way to restart', async () => {
    const stack = await withWorld()
    await interruptedGoto(stack, false)
    const tool = new ResumeInterruptedTaskTool(stack.journal, () =>
      Promise.reject(new Error('must not be called')),
    )
    stack.journal.markResumed('job-1')

    expect(await tool.execute({ id: 'job-9' }, context)).toEqual({
      ok: false,
      error: 'There is no job job-9.',
    })
    expect(await tool.execute({ id: 'job-1' }, context)).toEqual({
      ok: false,
      error: 'Job job-1 is resumed, not interrupted.',
    })
  })

  it('cannot resume a job that has no resume descriptor', async () => {
    const stack = await withWorld()
    await interruptedGoto(stack, false)
    const tool = new ResumeInterruptedTaskTool(stack.journal, () =>
      Promise.reject(new Error('must not be called')),
    )

    const result = await tool.execute({ id: 'job-1' }, context)

    expect(!result.ok && result.error).toContain('cannot be resumed automatically')
  })

  it('discard_interrupted_task drops the job from the interrupted list', async () => {
    const stack = await withWorld()
    await interruptedGoto(stack)
    const tool = new DiscardInterruptedTaskTool(stack.journal)

    expect(tool.execute({ id: 'job-1' })).toEqual({ ok: true, data: { discarded: 'job-1' } })
    expect(tool.execute({ id: 'job-1' }).ok).toBe(false)
    expect(stack.journal.interrupted()).toEqual([])
  })
})

describe('memory tools', () => {
  it('remember, recall, and forget notes', async () => {
    const stack = await withWorld()
    const remember = new RememberTool(stack.notes)
    const recall = new RecallTool(stack.notes)
    const forget = new ForgetTool(stack.notes)

    expect(remember.execute({ text: 'Base at 100, 64, -20', tags: ['base'] })).toMatchObject({
      ok: true,
      data: { note: { id: 'note-1' } },
    })
    expect(remember.execute({ text: 'Prefers oak', tags: [] }).ok).toBe(true)
    expect(recall.execute({ query: 'oak', limit: 20 })).toMatchObject({
      ok: true,
      data: { count: 1, notes: [{ text: 'Prefers oak' }] },
    })
    expect(recall.execute({ limit: 20 })).toMatchObject({ data: { count: 2 } })
    expect(forget.execute({ id: 'note-1' })).toEqual({ ok: true, data: { forgotten: 'note-1' } })
    expect(forget.execute({ id: 'note-1' }).ok).toBe(false)
  })

  it('note tools fail when no world is active', () => {
    const stack = buildStateStack()

    expect(new RememberTool(stack.notes).execute({ text: 'x', tags: [] }).ok).toBe(false)
    expect(new RecallTool(stack.notes).execute({ limit: 20 }).ok).toBe(false)
  })

  it('get_recent_history returns the log, optionally by kind', async () => {
    const stack = await withWorld()
    stack.history.record('chat', 'Andrey: hi')
    stack.history.record('tool', 'goto() → ok')
    const tool = new GetRecentHistoryTool(stack.history)

    expect(tool.execute({ limit: 20 })).toMatchObject({ ok: true, data: { count: 2 } })
    expect(tool.execute({ limit: 20, kind: 'tool' })).toMatchObject({
      data: { count: 1, entries: [{ kind: 'tool' }] },
    })
  })

  it('set and remove standing instructions', async () => {
    const stack = await withWorld()
    const set = new SetStandingInstructionTool(stack.standing)
    const remove = new RemoveStandingInstructionTool(stack.standing)

    expect(set.execute({ key: 'inventory_full', text: 'offload to the home chest' })).toEqual({
      ok: true,
      data: {
        key: 'inventory_full',
        instructions: { inventory_full: 'offload to the home chest' },
      },
    })
    expect(set.execute({ key: 'Bad Key', text: 'x' }).ok).toBe(false)
    expect(remove.execute({ key: 'inventory_full' })).toEqual({
      ok: true,
      data: { removed: 'inventory_full', instructions: {} },
    })
    expect(remove.execute({ key: 'inventory_full' }).ok).toBe(false)
  })
})
