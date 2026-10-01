import { describe, expect, it } from '@jest/globals'
import { ok } from '../../../src/core/result.js'
import type { DecisionPrompt } from '../../../src/core/skill.types.js'
import { TaskManager } from '../../../src/tasks/task-manager.js'
import type { TaskEvent } from '../../../src/tasks/task.types.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { FakeLogger } from '../../fakes/fake-logger.js'
import { FakeScheduler } from '../../fakes/fake-scheduler.js'

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const prompt: DecisionPrompt = { message: 'Full. What now?', options: ['offload', 'stop'] }

function setup() {
  const clock = new FakeClock(Date.UTC(2026, 8, 19, 12))
  const scheduler = new FakeScheduler(clock)
  const tasks = new TaskManager({ clock, scheduler, logger: new FakeLogger() })
  const events: TaskEvent[] = []
  tasks.onEvent((event) => {
    events.push(event)
  })
  return { tasks, scheduler, events }
}

/** A task that asks once and finishes with the answer. */
function asking(tasks: TaskManager) {
  const answers: (string | undefined)[] = []
  const started = tasks.start({
    name: 'collect_block',
    description: 'Collect logs',
    run: async (context) => {
      answers.push(await context.ask?.(prompt))
      return ok('done')
    },
  })
  if (!started.ok) throw new Error(started.error)
  return { id: started.value.id, answers }
}

describe('TaskManager: waiting for input', () => {
  it('shows the question while the task waits, and tells listeners', async () => {
    const { tasks, events } = setup()

    const { id } = asking(tasks)
    await flush()

    expect(tasks.get(id)).toMatchObject({ status: 'waiting_for_input', pending: prompt })
    expect(tasks.current()?.id).toBe(id) // it still holds the slot
    expect(events.map((e) => e.type)).toEqual(['started', 'waiting'])
  })

  it('carries on with the answer, and clears the question', async () => {
    const { tasks, events } = setup()
    const { id, answers } = asking(tasks)
    await flush()

    const answered = tasks.answer('offload')
    await flush()

    expect(answered).toMatchObject({ ok: true })
    expect(answers).toEqual(['offload'])
    expect(tasks.get(id)).toMatchObject({ status: 'succeeded', pending: undefined })
    expect(events.map((e) => e.type)).toEqual(['started', 'waiting', 'progress', 'finished'])
  })

  it('answers a task by id, and only with an offered option', async () => {
    const { tasks } = setup()
    const { id } = asking(tasks)
    await flush()

    expect(tasks.answer('dance', id)).toEqual({ ok: false, error: 'Choose one of: offload, stop.' })
    expect(tasks.get(id)?.status).toBe('waiting_for_input')
    expect(tasks.answer('stop', id).ok).toBe(true)
  })

  it('refuses an answer when nothing waits', () => {
    const { tasks } = setup()

    expect(tasks.answer('offload')).toEqual({
      ok: false,
      error: 'No task is waiting for an answer.',
    })
    tasks.start({ name: 'x', description: 'x', run: () => new Promise(() => undefined) })
    expect(tasks.answer('offload')).toEqual({
      ok: false,
      error: 'Task task-1 is not waiting for an answer.',
    })
    expect(tasks.answer('offload', 'task-9').ok).toBe(false)
  })

  it('makes waitFor return at once, so the agent hears about the question without waiting out its budget', async () => {
    const { tasks, scheduler } = setup()
    const { id } = asking(tasks)

    const waiting = tasks.waitFor(id, 30_000)
    await flush()
    const snapshot = await waiting

    expect(snapshot?.status).toBe('waiting_for_input')
    expect(scheduler.pendingCount).toBe(0)
    expect((await tasks.waitFor(id, 30_000))?.status).toBe('waiting_for_input') // already waiting
  })

  it('resolves the question with undefined when the task is cancelled meanwhile', async () => {
    const { tasks } = setup()
    const { id, answers } = asking(tasks)
    await flush()

    await tasks.cancel(id)

    expect(answers).toEqual([undefined])
    expect(tasks.get(id)).toMatchObject({ status: 'cancelled', pending: undefined })
  })

  it('does not ask on a task that is already cancelled', async () => {
    const { tasks } = setup()
    const late: (string | undefined)[] = []
    const started = tasks.start({
      name: 'x',
      description: 'x',
      run: async (context) => {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => {
            resolve()
          })
        })
        late.push(await context.ask?.(prompt))
        return ok('done')
      },
    })
    if (!started.ok) throw new Error(started.error)

    await tasks.cancel(started.value.id)

    expect(late).toEqual([undefined])
  })

  it('a waiting task blocks new ones until it is cancelled or replaced', async () => {
    const { tasks } = setup()
    asking(tasks)
    await flush()

    const second = tasks.start({
      name: 'y',
      description: 'y',
      run: () => Promise.resolve(ok('done')),
    })

    expect(second.ok).toBe(false)
    await tasks.cancel(undefined, 'replaced')
    expect(
      tasks.start({ name: 'y', description: 'y', run: () => Promise.resolve(ok('done')) }).ok,
    ).toBe(true)
  })
})
