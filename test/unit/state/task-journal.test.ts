import { describe, expect, it } from '@jest/globals'
import { err, ok, type Result } from '../../../src/core/result.js'
import type { SkillContext, SkillFailure } from '../../../src/core/skill.types.js'
import { MAX_JOBS, TaskJournal } from '../../../src/state/task-journal.js'
import type { TaskSpec } from '../../../src/tasks/task.types.js'
import { InMemoryStateStore, buildStateStack } from '../../fakes/state-fakes.js'

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** A task the test finishes by hand; it honors the abort signal like a real skill. */
function controllable(name = 'goto', withResume = true) {
  let context: SkillContext | undefined
  let finish: (result: Result<unknown, SkillFailure>) => void = () => undefined
  const spec: TaskSpec = {
    name,
    description: `Do ${name}`,
    ...(withResume ? { resume: { tool: name, arguments: { x: 1, y: 2, z: 3 } } } : {}),
    run: (ctx) => {
      context = ctx
      return new Promise((resolve) => {
        finish = resolve
        ctx.signal.addEventListener('abort', () => {
          resolve(err({ reason: 'aborted', message: 'Cancelled.' }))
        })
      })
    },
  }
  return {
    spec,
    finish: (r: Result<unknown, SkillFailure>) => {
      finish(r)
    },
    context: () => context,
  }
}

async function withWorld() {
  const stack = buildStateStack()
  await stack.worldState.open({ seed: 'aa', worldName: 'W', spawn: null })
  return stack
}

describe('TaskJournal', () => {
  it('ignores tasks while no world is active', async () => {
    const stack = buildStateStack()
    const task = controllable()

    stack.tasks.start(task.spec)
    task.finish(ok(1))
    await flush()

    expect(stack.journal.recent(10)).toEqual([])
  })

  it('records a task from start to success', async () => {
    const stack = await withWorld()
    const task = controllable()

    stack.tasks.start(task.spec)
    task.context()?.progress('5 blocks to go')
    task.finish(ok({ arrived: true }))
    await flush()

    expect(stack.journal.recent(10)).toEqual([
      {
        id: 'job-1',
        name: 'goto',
        description: 'Do goto',
        status: 'succeeded',
        progress: '5 blocks to go',
        failure: null,
        resume: { tool: 'goto', arguments: { x: 1, y: 2, z: 3 } },
        startedAt: '2026-09-19T12:00:00.000Z',
        finishedAt: '2026-09-19T12:00:00.000Z',
      },
    ])
  })

  it('records a failure with its reason', async () => {
    const stack = await withWorld()
    const task = controllable()

    stack.tasks.start(task.spec)
    task.finish(err({ reason: 'unreachable', message: 'No path.' }))
    await flush()

    expect(stack.journal.get('job-1')).toMatchObject({
      status: 'failed',
      failure: { reason: 'unreachable', message: 'No path.' },
    })
  })

  it('treats a deliberate stop or a replacement as cancelled, not interrupted', async () => {
    const stack = await withWorld()
    stack.tasks.start(controllable().spec)
    await stack.tasks.cancel(undefined, 'requested')
    stack.tasks.start(controllable().spec)
    await stack.tasks.cancel(undefined, 'replaced')

    expect(stack.journal.recent(10).map((j) => j.status)).toEqual(['cancelled', 'cancelled'])
    expect(stack.journal.interrupted()).toEqual([])
  })

  it('treats a disconnect or shutdown as interrupted', async () => {
    const stack = await withWorld()
    stack.tasks.start(controllable().spec)
    await stack.tasks.cancel(undefined, 'disconnected')
    stack.tasks.start(controllable('follow_player').spec)
    await stack.tasks.cancel(undefined, 'shutdown')

    expect(stack.journal.interrupted().map((j) => j.name)).toEqual(['goto', 'follow_player'])
  })

  it('marks jobs that were still running when the world is reopened (a crash) as interrupted', async () => {
    const stack = await withWorld()
    stack.tasks.start(controllable().spec)
    stack.scheduler.advance(1000)
    const store = stack.profileStores.get('w') as InMemoryStateStore
    // the app is killed here: no finish event, no clean close

    const restarted = buildStateStack({
      profileStores: new Map([['w', store]]),
      rootStore: stack.rootStore,
    })
    await restarted.worldState.open({ seed: 'aa', worldName: 'W', spawn: null })

    expect(restarted.journal.interrupted()).toMatchObject([
      { id: 'job-1', status: 'interrupted', description: 'Do goto' },
    ])
    expect(restarted.journal.interrupted()[0]?.finishedAt).not.toBeNull()
  })

  it('numbers new jobs after the saved ones', async () => {
    const stack = await withWorld()
    const first = controllable()
    stack.tasks.start(first.spec)
    first.finish(ok(1))
    await flush()
    await stack.worldState.close()

    await stack.worldState.open({ seed: 'aa', worldName: 'W', spawn: null })
    stack.tasks.start(controllable().spec)

    expect(stack.journal.recent(10).map((j) => j.id)).toEqual(['job-2', 'job-1'])
  })

  describe('interrupted jobs', () => {
    async function withInterrupted(withResume = true) {
      const stack = await withWorld()
      stack.tasks.start(controllable('goto', withResume).spec)
      await stack.tasks.cancel(undefined, 'disconnected')
      return stack
    }

    it('can be marked as resumed, once', async () => {
      const stack = await withInterrupted()

      expect(stack.journal.markResumed('job-1')).toMatchObject({
        ok: true,
        value: { status: 'resumed' },
      })
      expect(stack.journal.interrupted()).toEqual([])
      expect(stack.journal.markResumed('job-1')).toEqual(
        err('Job job-1 is resumed, not interrupted.'),
      )
    })

    it('can be discarded', async () => {
      const stack = await withInterrupted()

      expect(stack.journal.discard('job-1')).toMatchObject({
        ok: true,
        value: { status: 'discarded' },
      })
      expect(stack.journal.interrupted()).toEqual([])
    })

    it('reports unknown ids, and jobs that are not interrupted', async () => {
      const stack = await withWorld()
      const done = controllable()
      stack.tasks.start(done.spec)
      done.finish(ok(1))
      await flush()

      expect(stack.journal.discard('job-9')).toEqual(err('There is no job job-9.'))
      expect(stack.journal.discard('job-1')).toEqual(
        err('Job job-1 is succeeded, not interrupted.'),
      )
    })

    it('a job without a way to restart it has no resume descriptor', async () => {
      const stack = await withInterrupted(false)

      expect(stack.journal.get('job-1')?.resume).toBeNull()
    })
  })

  it('refuses transitions while no world is active', () => {
    const stack = buildStateStack()

    expect(stack.journal.markResumed('job-1').ok).toBe(false)
    expect(stack.journal.discard('job-1').ok).toBe(false)
  })

  it('keeps at most MAX_JOBS jobs, dropping the oldest finished ones but never an interrupted one', async () => {
    const stack = await withWorld()
    stack.tasks.start(controllable().spec)
    await stack.tasks.cancel(undefined, 'disconnected') // job-1 stays (interrupted)
    for (let i = 0; i < MAX_JOBS + 5; i += 1) {
      const task = controllable()
      stack.tasks.start(task.spec)
      task.finish(ok(i))
      await flush()
    }

    const jobs = stack.journal.recent(MAX_JOBS + 10)
    expect(jobs.length).toBeLessThanOrEqual(MAX_JOBS + 1)
    expect(stack.journal.get('job-1')?.status).toBe('interrupted')
  })

  it('forgets everything on detach and reports store warnings', async () => {
    const store = new InMemoryStateStore()
    store.warnOnLoad = 'journal.json was corrupt'
    const stack = buildStateStack()

    expect(await stack.journal.attach(store)).toEqual(['journal.json was corrupt'])
    stack.journal.detach()
    expect(stack.journal.recent(5)).toEqual([])
  })

  it('needs no world for a fresh journal to be created standalone', () => {
    const stack = buildStateStack()

    expect(new TaskJournal(stack.clock, stack.tasks).interrupted()).toEqual([])
  })
})
