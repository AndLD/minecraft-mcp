import { describe, expect, it } from '@jest/globals'
import { err, ok } from '../../../../src/core/result.js'
import type { SkillResult } from '../../../../src/core/skill.types.js'
import { AutoRecovery, type RecoveryTasks } from '../../../../src/skills/recovery/auto-recovery.js'
import type {
  RecoverInput,
  RecoverOutput,
} from '../../../../src/skills/recovery/recover-drops-skill.js'
import { DropRecords } from '../../../../src/state/drop-records.js'
import type { TaskEvent, TaskSnapshot, TaskSpec } from '../../../../src/tasks/task.types.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { AutoScheduler } from '../../../fakes/gathering-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const snapshot = (id: string, patch: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  id,
  name: 'recover_drops',
  description: 'x',
  status: 'running',
  progress: undefined,
  result: undefined,
  failure: undefined,
  cancelReason: undefined,
  resume: undefined,
  pending: undefined,
  startedAt: 0,
  finishedAt: undefined,
  ...patch,
})

class StubTasks implements RecoveryTasks {
  readonly specs: TaskSpec[] = []
  /** How many starts to refuse ("a task is still running") before accepting. */
  busyFor = 0
  private listeners: ((event: TaskEvent) => void)[] = []
  attempts = 0

  start(spec: TaskSpec) {
    this.attempts += 1
    if (this.busyFor > 0) {
      this.busyFor -= 1
      return err('Task task-1 is still running.')
    }
    this.specs.push(spec)
    return ok(snapshot(`task-${String(this.specs.length)}`))
  }

  onEvent(listener: (event: TaskEvent) => void) {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  finish(patch: Partial<TaskSnapshot>, id = 'task-1'): void {
    for (const listener of [...this.listeners])
      listener({ type: 'finished', snapshot: snapshot(id, patch) })
  }

  get listening(): number {
    return this.listeners.length
  }
}

const output = (patch: Partial<RecoverOutput> = {}): RecoverOutput => ({
  record: 'drop-1',
  kind: 'death',
  position: { x: 1, y: 2, z: 3 },
  status: 'recovered',
  recovered: [{ name: 'iron_ingot', count: 20 }],
  missing: [],
  gear: undefined,
  ...patch,
})

async function setup(maxTries = 5) {
  const clock = new FakeClock(0)
  const records = new DropRecords(clock)
  await records.attach(new InMemoryStateStore())
  records.add({
    kind: 'death',
    position: { x: 1, y: 2, z: 3 },
    dimension: 'overworld',
    at: 0,
    cause: null,
    lost: [{ name: 'iron_ingot', count: 20 }],
    note: null,
  })
  const tasks = new StubTasks()
  const inputs: RecoverInput[] = []
  const events: { type: string; message: string }[] = []
  const said: string[] = []
  const reflex = { name: undefined as string | undefined }
  const runs: SkillResult<RecoverOutput>[] = []
  const auto = new AutoRecovery({
    tasks,
    recoverer: {
      run: (input) => {
        inputs.push(input)
        return Promise.resolve(runs.shift() ?? ok(output()))
      },
    },
    records,
    activeReflex: () => reflex.name,
    emit: (type, message) => {
      events.push({ type, message })
    },
    say: (text) => {
      said.push(text)
    },
    scheduler: new AutoScheduler(clock),
    maxAttempts: 2,
    retryDelayMs: 5_000,
    maxTries,
  })
  return { clock, records, tasks, inputs, events, said, reflex, auto }
}

describe('AutoRecovery', () => {
  it('starts a recovery task for the record, which can be resumed by tool and record', async () => {
    const s = await setup()

    await s.auto.start('drop-1')

    expect(s.tasks.specs).toHaveLength(1)
    expect(s.tasks.specs[0]).toMatchObject({
      name: 'recover_drops',
      resume: { tool: 'recover_drops', arguments: { record: 'drop-1' } },
    })
    await s.tasks.specs[0]?.run({ signal: new AbortController().signal, progress: () => undefined })
    expect(s.inputs).toEqual([{ record: 'drop-1', maxAttempts: 2 }])
  })

  it('waits for a running task or an acting reflex, then starts', async () => {
    const s = await setup()
    s.tasks.busyFor = 2
    s.reflex.name = 'threat_response'

    const started = s.auto.start('drop-1')
    await Promise.resolve()
    s.reflex.name = undefined
    await started

    expect(s.tasks.attempts).toBe(3)
    expect(s.tasks.specs).toHaveLength(1)
    expect(s.clock.now()).toBeGreaterThanOrEqual(10_000)
  })

  it('gives up after a while and tells the agent, instead of waiting forever', async () => {
    const s = await setup(3)
    s.tasks.busyFor = 99

    await s.auto.start('drop-1')

    expect(s.tasks.specs).toEqual([])
    expect(s.events).toHaveLength(1)
    expect(s.events[0]?.message).toContain('never started recovering drop-1')
  })

  it('does not start for a record the player has skipped meanwhile', async () => {
    const s = await setup()
    s.tasks.busyFor = 1
    const started = s.auto.start('drop-1')
    s.records.update('drop-1', { status: 'abandoned' })
    await started

    expect(s.tasks.specs).toEqual([])
    expect(s.events).toEqual([])
  })

  it('does nothing for an unknown record', async () => {
    const s = await setup()

    await s.auto.start('drop-9')

    expect(s.tasks.attempts).toBe(0)
  })

  it('tells the agent and the chat what came back', async () => {
    const s = await setup()
    await s.auto.start('drop-1')

    s.tasks.finish({ status: 'succeeded', result: output() })

    expect(s.events).toEqual([
      { type: 'drop_recovery', message: 'Recovered 20 iron_ingot (recovered).' },
    ])
    expect(s.said).toEqual(['Recovered 20 iron_ingot (recovered).'])
    expect(s.tasks.listening).toBe(0)
  })

  it('names what is still missing', async () => {
    const s = await setup()
    await s.auto.start('drop-1')

    s.tasks.finish({
      status: 'succeeded',
      result: output({ status: 'partial', missing: [{ name: 'iron_pickaxe', count: 1 }] }),
    })

    expect(s.said[0]).toBe('Recovered 20 iron_ingot (partial). Still missing: 1 iron_pickaxe.')
  })

  it('says when the dropped items are simply gone', async () => {
    const s = await setup()
    await s.auto.start('drop-1')

    s.tasks.finish({ status: 'succeeded', result: output({ status: 'gone', recovered: [] }) })

    expect(s.said[0]).toContain('no longer there')
  })

  it('says why a recovery failed, with the reason from the skill', async () => {
    const s = await setup()
    await s.auto.start('drop-1')

    s.tasks.finish({
      status: 'failed',
      failure: { reason: 'too_far', message: 'The bot needs about 300 s to reach 1, 2, 3.' },
    })

    expect(s.events[0]?.message).toBe(
      'Recovery did not work out: The bot needs about 300 s to reach 1, 2, 3.',
    )
  })

  it('says when the recovery was cancelled', async () => {
    const s = await setup()
    await s.auto.start('drop-1')

    s.tasks.finish({ status: 'cancelled', cancelReason: 'requested' })

    expect(s.said[0]).toBe('Recovery was cancelled.')
  })

  it('keeps chat lines short and ignores other tasks finishing', async () => {
    const s = await setup()
    await s.auto.start('drop-1')

    s.tasks.finish({ status: 'succeeded', result: output() }, 'task-9') // someone else's task
    expect(s.said).toEqual([])

    s.tasks.finish({
      status: 'failed',
      failure: { reason: 'x', message: 'y'.repeat(500) },
    })
    expect(s.said[0]).toHaveLength(240)
    expect(s.events[0]?.message.length).toBeGreaterThan(240)
  })
})
