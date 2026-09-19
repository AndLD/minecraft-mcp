import { describe, expect, it } from '@jest/globals'
import { err, ok, type Result } from '../../../src/core/result.js'
import type { SkillContext, SkillFailure } from '../../../src/core/skill.types.js'
import { TaskManager } from '../../../src/tasks/task-manager.js'
import type { TaskSpec } from '../../../src/tasks/task.types.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { FakeLogger } from '../../fakes/fake-logger.js'
import { FakeScheduler } from '../../fakes/fake-scheduler.js'

function setup(options: { historyLimit?: number; cancelGraceMs?: number } = {}) {
  const clock = new FakeClock(1000)
  const scheduler = new FakeScheduler(clock)
  const logger = new FakeLogger()
  const manager = new TaskManager({ clock, scheduler, logger, ...options })
  return { clock, scheduler, logger, manager }
}

/** A task that finishes when the test calls `finish`, and honors the abort signal unless told not to. */
function controllable(name = 'work', honorAbort = true) {
  let context: SkillContext | undefined
  let finish: (result: Result<unknown, SkillFailure>) => void = () => undefined
  const spec: TaskSpec = {
    name,
    description: `Do ${name}`,
    run: (ctx) => {
      context = ctx
      return new Promise((resolve) => {
        finish = resolve
        if (honorAbort)
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

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('TaskManager', () => {
  describe('starting', () => {
    it('starts a task and reports it as running', () => {
      const { manager } = setup()
      const task = controllable()

      const started = manager.start(task.spec)

      expect(started).toMatchObject({
        ok: true,
        value: { id: 'task-1', name: 'work', status: 'running', startedAt: 1000 },
      })
      expect(manager.current()?.id).toBe('task-1')
      expect(manager.latest()?.id).toBe('task-1')
      expect(manager.get('task-1')?.description).toBe('Do work')
    })

    it('refuses to start a second task while one is running', () => {
      const { manager } = setup()
      manager.start(controllable().spec)

      const second = manager.start(controllable('other').spec)

      expect(second.ok).toBe(false)
      expect(!second.ok && second.error).toContain('task-1')
      expect(!second.ok && second.error).toContain('replace=true')
    })

    it('allows a new task once the previous one finished', async () => {
      const { manager } = setup()
      const first = controllable()
      manager.start(first.spec)
      first.finish(ok('done'))
      await flush()

      expect(manager.start(controllable().spec)).toMatchObject({
        ok: true,
        value: { id: 'task-2' },
      })
    })
  })

  describe('finishing', () => {
    it('records success with the result and finish time', async () => {
      const { manager, clock } = setup()
      const task = controllable()
      manager.start(task.spec)
      clock.advance(2500)

      task.finish(ok({ arrived: true }))
      await flush()

      expect(manager.get('task-1')).toMatchObject({
        status: 'succeeded',
        result: { arrived: true },
        finishedAt: 3500,
      })
      expect(manager.current()).toBeUndefined()
    })

    it('records an expected failure with its reason', async () => {
      const { manager } = setup()
      const task = controllable()
      manager.start(task.spec)

      task.finish(err({ reason: 'unreachable', message: 'No path.' }))
      await flush()

      expect(manager.get('task-1')).toMatchObject({
        status: 'failed',
        failure: { reason: 'unreachable', message: 'No path.' },
      })
    })

    it('turns a crash into a failed task and logs it', async () => {
      const { manager, logger } = setup()
      manager.start({
        name: 'boom',
        description: 'Crashes',
        run: () => Promise.reject(new Error('bug')),
      })
      await flush()

      expect(manager.get('task-1')).toMatchObject({
        status: 'failed',
        failure: { reason: 'internal_error', message: 'Internal error: bug' },
      })
      expect(logger.entries.map((e) => e.level)).toEqual(['error'])
    })

    it('describes a non-Error crash too', async () => {
      const { manager } = setup()
      manager.start({
        name: 'boom',
        description: 'Throws a string',
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is the case under test
        run: () => Promise.reject('text'),
      })
      await flush()

      expect(manager.get('task-1')?.failure?.message).toBe('Internal error: text')
    })

    it('keeps the latest progress message', () => {
      const { manager } = setup()
      const task = controllable()
      manager.start(task.spec)

      task.context()?.progress('10 blocks to go')
      task.context()?.progress('5 blocks to go')

      expect(manager.get('task-1')?.progress).toBe('5 blocks to go')
    })

    it('ignores progress reported after the task finished', async () => {
      const { manager } = setup()
      const task = controllable()
      manager.start(task.spec)
      task.finish(ok(1))
      await flush()

      task.context()?.progress('too late')

      expect(manager.get('task-1')?.progress).toBeUndefined()
    })
  })

  describe('waitFor', () => {
    it('resolves right away for an unknown id', async () => {
      expect(await setup().manager.waitFor('nope', 1000)).toBeUndefined()
    })

    it('resolves right away for a finished task', async () => {
      const { manager } = setup()
      const task = controllable()
      manager.start(task.spec)
      task.finish(ok(1))
      await flush()

      expect((await manager.waitFor('task-1', 1000))?.status).toBe('succeeded')
    })

    it('resolves when the task finishes', async () => {
      const { manager, scheduler } = setup()
      const task = controllable()
      manager.start(task.spec)

      const waiting = manager.waitFor('task-1', 30_000)
      task.finish(ok('x'))

      expect((await waiting)?.status).toBe('succeeded')
      expect(scheduler.pendingCount).toBe(0)
    })

    it('resolves with a running task after the timeout', async () => {
      const { manager, scheduler } = setup()
      manager.start(controllable().spec)

      const waiting = manager.waitFor('task-1', 30_000)
      scheduler.advance(30_000)

      expect((await waiting)?.status).toBe('running')
    })

    it('does not wait when the budget is zero or the signal is aborted', async () => {
      const { manager } = setup()
      manager.start(controllable().spec)
      const controller = new AbortController()
      controller.abort()

      expect((await manager.waitFor('task-1', 0))?.status).toBe('running')
      expect((await manager.waitFor('task-1', 5000, controller.signal))?.status).toBe('running')
    })

    it('stops waiting when aborted', async () => {
      const { manager, scheduler } = setup()
      manager.start(controllable().spec)
      const controller = new AbortController()

      const waiting = manager.waitFor('task-1', 30_000, controller.signal)
      controller.abort()

      expect((await waiting)?.status).toBe('running')
      expect(scheduler.pendingCount).toBe(0)
    })
  })

  describe('cancel', () => {
    it('aborts the running task and waits until it stopped', async () => {
      const { manager } = setup()
      const task = controllable()
      manager.start(task.spec)

      const snapshot = await manager.cancel()

      expect(snapshot?.status).toBe('cancelled')
      expect(task.context()?.signal.aborted).toBe(true)
      expect(manager.current()).toBeUndefined()
    })

    it('cancels a task by id', async () => {
      const { manager } = setup()
      manager.start(controllable().spec)

      expect((await manager.cancel('task-1'))?.status).toBe('cancelled')
    })

    it('reports a task as cancelled even if it finished successfully after the abort', async () => {
      const { manager } = setup()
      const task = controllable('work', false)
      manager.start(task.spec)

      const cancelling = manager.cancel()
      task.finish(ok('finished anyway'))

      expect((await cancelling)?.status).toBe('cancelled')
    })

    it('does nothing when nothing is running or the id is unknown', async () => {
      const { manager } = setup()

      expect(await manager.cancel()).toBeUndefined()
      expect(await manager.cancel('task-9')).toBeUndefined()
    })

    it('returns the final state when the task already finished', async () => {
      const { manager } = setup()
      const task = controllable()
      manager.start(task.spec)
      task.finish(ok(1))
      await flush()

      expect((await manager.cancel('task-1'))?.status).toBe('succeeded')
    })

    it('frees the slot after the grace period when the task ignores the abort', async () => {
      const { manager, scheduler, logger } = setup({ cancelGraceMs: 3000 })
      manager.start(controllable('stubborn', false).spec)

      const cancelling = manager.cancel()
      scheduler.advance(3000)
      const snapshot = await cancelling

      expect(snapshot?.status).toBe('cancelled')
      expect(manager.current()).toBeUndefined()
      expect(logger.entries.map((e) => e.level)).toEqual(['warn'])
      expect(manager.start(controllable('next').spec).ok).toBe(true)
    })

    it('does not let a zombie task overwrite its cancelled state', async () => {
      const { manager, scheduler } = setup({ cancelGraceMs: 1000 })
      const stubborn = controllable('stubborn', false)
      manager.start(stubborn.spec)
      const cancelling = manager.cancel()
      scheduler.advance(1000)
      await cancelling

      stubborn.finish(ok('late'))
      await flush()

      expect(manager.get('task-1')?.status).toBe('cancelled')
    })
  })

  describe('stopAll', () => {
    it('cancels the running task without waiting', async () => {
      const { manager } = setup()
      const task = controllable()
      manager.start(task.spec)

      manager.stopAll()
      await flush()

      expect(task.context()?.signal.aborted).toBe(true)
      expect(manager.get('task-1')?.status).toBe('cancelled')
    })

    it('is harmless when nothing is running', () => {
      expect(() => {
        setup().manager.stopAll()
      }).not.toThrow()
    })
  })

  describe('events and cancel reasons', () => {
    it('tells listeners when a task starts, reports progress, and finishes', async () => {
      const { manager } = setup()
      const seen: string[] = []
      manager.onEvent((event) =>
        seen.push(`${event.type}:${event.snapshot.status}:${event.snapshot.progress ?? '-'}`),
      )
      const task = controllable()

      manager.start(task.spec)
      task.context()?.progress('halfway')
      task.finish(ok(1))
      await flush()

      expect(seen).toEqual([
        'started:running:-',
        'progress:running:halfway',
        'finished:succeeded:halfway',
      ])
    })

    it('stops notifying a listener that unsubscribed', () => {
      const { manager } = setup()
      const seen: string[] = []
      const stop = manager.onEvent((event) => seen.push(event.type))
      stop()

      manager.start(controllable().spec)

      expect(seen).toEqual([])
    })

    it('records why a task was cancelled: requested by default, or the reason given', async () => {
      const { manager } = setup()
      manager.start(controllable().spec)
      await manager.cancel()
      manager.start(controllable().spec)
      await manager.cancel(undefined, 'disconnected')

      expect(manager.get('task-1')).toMatchObject({
        status: 'cancelled',
        cancelReason: 'requested',
      })
      expect(manager.get('task-2')).toMatchObject({
        status: 'cancelled',
        cancelReason: 'disconnected',
      })
    })

    it('keeps the reason when a stubborn task is released after the grace period', async () => {
      const { manager, scheduler } = setup({ cancelGraceMs: 1000 })
      manager.start(controllable('stubborn', false).spec)

      const cancelling = manager.cancel(undefined, 'shutdown')
      scheduler.advance(1000)
      await cancelling

      expect(manager.get('task-1')?.cancelReason).toBe('shutdown')
    })

    it('has no cancel reason for tasks that were not cancelled, and carries the resume descriptor', async () => {
      const { manager } = setup()
      const task = controllable()
      const spec = { ...task.spec, resume: { tool: 'goto', arguments: { x: 1 } } }

      manager.start(spec)
      task.finish(ok(1))
      await flush()

      expect(manager.get('task-1')).toMatchObject({
        cancelReason: undefined,
        resume: { tool: 'goto', arguments: { x: 1 } },
      })
    })

    it('stopAll counts as a requested cancel', async () => {
      const { manager } = setup()
      manager.start(controllable().spec)

      manager.stopAll()
      await flush()

      expect(manager.get('task-1')?.cancelReason).toBe('requested')
    })
  })

  describe('history', () => {
    it('remembers only the most recent finished tasks', async () => {
      const { manager } = setup({ historyLimit: 2 })
      for (let i = 0; i < 4; i += 1) {
        const task = controllable()
        manager.start(task.spec)
        task.finish(ok(i))
        await flush()
      }

      expect(manager.get('task-1')).toBeUndefined()
      expect(manager.get('task-2')).toBeUndefined()
      expect(manager.get('task-3')?.status).toBe('succeeded')
      expect(manager.latest()?.id).toBe('task-4')
    })

    it('has no latest task before anything ran', () => {
      expect(setup().manager.latest()).toBeUndefined()
    })
  })
})
