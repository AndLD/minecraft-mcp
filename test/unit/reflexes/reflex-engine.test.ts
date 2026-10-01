import { describe, expect, it } from '@jest/globals'
import type {
  Reflex,
  ReflexContext,
  ReflexOutcome,
  ReflexState,
} from '../../../src/reflexes/reflex.types.js'
import { ReflexEngine, type TaskPreemption } from '../../../src/reflexes/reflex-engine.js'
import type { ResumeDescriptor, TaskSnapshot } from '../../../src/tasks/task.types.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { FakeLogger } from '../../fakes/fake-logger.js'
import { buildVitals, FakeEntityScanner, FakeVitals } from '../../fakes/fake-ports.js'
import { FakeScheduler } from '../../fakes/fake-scheduler.js'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

/** A reflex the test controls: it wants to act while `active`, and runs until finished or aborted. */
class ScriptedReflex implements Reflex {
  active = false
  runs = 0
  aborted = 0
  outcome: ReflexOutcome = { resumeTask: true }
  contexts: ReflexContext[] = []
  lastState: ReflexState | undefined
  crashWith: Error | undefined
  private finishRun: () => void = () => undefined

  constructor(
    readonly name: string,
    readonly priority: number,
    readonly preemptsTask = true,
  ) {}

  wants(): boolean {
    return this.active
  }

  run(context: ReflexContext, state: ReflexState): Promise<ReflexOutcome> {
    this.runs += 1
    this.contexts.push(context)
    this.lastState = state
    if (this.crashWith !== undefined) return Promise.reject(this.crashWith)
    return new Promise((resolve) => {
      this.finishRun = () => {
        resolve(this.outcome)
      }
      context.signal.addEventListener('abort', () => {
        this.aborted += 1
        resolve(this.outcome)
      })
    })
  }

  finish(): void {
    this.active = false
    this.finishRun()
  }
}

class FakeTasks implements TaskPreemption {
  running: { description: string; resume: ResumeDescriptor | undefined } | undefined
  waiting: TaskSnapshot | undefined
  suspendCalls = 0
  takeCalls = 0

  suspend(): Promise<TaskSnapshot | undefined> {
    this.suspendCalls += 1
    if (this.running === undefined) return Promise.resolve(undefined)
    const snapshot = {
      id: 'task-1',
      name: 'goto',
      description: this.running.description,
      status: 'cancelled',
      cancelReason: 'preempted',
      resume: this.running.resume,
    } as unknown as TaskSnapshot
    this.running = undefined
    this.waiting = snapshot
    return Promise.resolve(snapshot)
  }

  suspended(): TaskSnapshot | undefined {
    return this.waiting
  }

  takeSuspended(): ResumeDescriptor | undefined {
    this.takeCalls += 1
    const resume = this.waiting?.resume
    this.waiting = undefined
    return resume
  }
}

function setup(reflexes: Reflex[]) {
  const clock = new FakeClock(1000)
  const scheduler = new FakeScheduler(clock)
  const vitals = new FakeVitals()
  vitals.vitals = buildVitals()
  const tasks = new FakeTasks()
  const emitted: string[] = []
  const resumed: ResumeDescriptor[] = []
  const logger = new FakeLogger()
  let resumeResult = true
  const engine = new ReflexEngine({
    reflexes,
    vitals,
    entities: new FakeEntityScanner(),
    tasks,
    resume: (descriptor) => {
      resumed.push(descriptor)
      return Promise.resolve(resumeResult)
    },
    emit: (message) => emitted.push(message),
    scheduler,
    clock,
    logger,
  })
  const tick = async (): Promise<void> => {
    scheduler.advance(250)
    await flush()
  }
  return {
    engine,
    vitals,
    tasks,
    emitted,
    resumed,
    logger,
    tick,
    scheduler,
    setResume: (v: boolean) => {
      resumeResult = v
    },
  }
}

describe('ReflexEngine', () => {
  describe('running reflexes', () => {
    it('does nothing until started, and start is idempotent', async () => {
      const reflex = new ScriptedReflex('a', 10)
      reflex.active = true
      const { engine, tick, scheduler } = setup([reflex])

      await tick()
      expect(reflex.runs).toBe(0)
      engine.start()
      engine.start()
      expect(engine.isStarted).toBe(true)
      expect(scheduler.pendingCount).toBe(1)
      await tick()
      expect(reflex.runs).toBe(1)
    })

    it('runs a reflex that wants to act, with the current state, and reports it as active', async () => {
      const reflex = new ScriptedReflex('eat', 10)
      const { engine, tick } = setup([reflex])
      engine.start()
      reflex.active = true

      await tick()

      expect(engine.activeReflex()).toBe('eat')
      expect(reflex.lastState).toMatchObject({ vitals: { health: 20 }, entities: [], now: 1250 })
    })

    it('lets a reflex finish on its own and then goes idle', async () => {
      const reflex = new ScriptedReflex('eat', 10)
      const { engine, tick } = setup([reflex])
      engine.start()
      reflex.active = true
      await tick()

      reflex.finish()
      await flush()

      expect(engine.activeReflex()).toBeUndefined()
    })

    it('does nothing while the bot is not in a world', async () => {
      const reflex = new ScriptedReflex('eat', 10)
      reflex.active = true
      const { engine, vitals, tick } = setup([reflex])
      engine.start()
      vitals.vitals = undefined

      await tick()

      expect(reflex.runs).toBe(0)
    })

    it('aborts the running reflex when the bot leaves the world', async () => {
      const reflex = new ScriptedReflex('eat', 10)
      const { engine, vitals, tick } = setup([reflex])
      engine.start()
      reflex.active = true
      await tick()

      vitals.vitals = undefined
      await tick()

      expect(reflex.aborted).toBe(1)
      expect(engine.activeReflex()).toBeUndefined()
    })

    it('aborts a reflex that no longer wants to act', async () => {
      const reflex = new ScriptedReflex('threat', 80)
      const { engine, tick } = setup([reflex])
      engine.start()
      reflex.active = true
      await tick()

      reflex.active = false
      await tick()

      expect(reflex.aborted).toBe(1)
    })

    it('starts the same reflex again on a later tick if it still wants to act after finishing', async () => {
      const reflex = new ScriptedReflex('eat', 10)
      const { engine, tick } = setup([reflex])
      engine.start()
      reflex.active = true
      await tick()
      reflex.finish()
      reflex.active = true
      await flush()

      await tick()

      expect(reflex.runs).toBe(2)
    })
  })

  describe('priority', () => {
    it('a more important reflex takes over from a less important one', async () => {
      const eat = new ScriptedReflex('eat', 20, false)
      const fight = new ScriptedReflex('fight', 80)
      const { engine, tick } = setup([eat, fight])
      engine.start()
      eat.active = true
      await tick()
      expect(engine.activeReflex()).toBe('eat')

      fight.active = true
      await tick()

      expect(eat.aborted).toBe(1)
      expect(engine.activeReflex()).toBe('fight')
    })

    it('a less important reflex never interrupts a more important one', async () => {
      const eat = new ScriptedReflex('eat', 20, false)
      const fight = new ScriptedReflex('fight', 80)
      const { engine, tick } = setup([eat, fight])
      engine.start()
      fight.active = true
      await tick()

      eat.active = true
      await tick()

      expect(fight.aborted).toBe(0)
      expect(eat.runs).toBe(0)
      expect(engine.activeReflex()).toBe('fight')
    })

    it('picks the most important when several want to act at once, regardless of list order', async () => {
      const low = new ScriptedReflex('low', 1)
      const high = new ScriptedReflex('high', 99)
      const mid = new ScriptedReflex('mid', 50)
      const { engine, tick } = setup([low, high, mid])
      engine.start()
      for (const r of [low, high, mid]) r.active = true

      await tick()

      expect(engine.activeReflex()).toBe('high')
      expect(low.runs + mid.runs).toBe(0)
    })

    it('goes on to a lower reflex when the higher one finishes and it still wants to act', async () => {
      const eat = new ScriptedReflex('eat', 20, false)
      const fight = new ScriptedReflex('fight', 80)
      const { engine, tick } = setup([eat, fight])
      engine.start()
      eat.active = true
      fight.active = true
      await tick()

      fight.finish()
      await flush()
      await tick()

      expect(engine.activeReflex()).toBe('eat')
    })
  })

  describe('pausing and resuming the task', () => {
    const goto: ResumeDescriptor = { tool: 'goto', arguments: { x: 10, y: 64, z: 5 } }

    it('stops the running task when a reflex that needs the body takes over, and tells the agent', async () => {
      const fight = new ScriptedReflex('threat_response', 80)
      const { engine, tick, tasks, emitted } = setup([fight])
      tasks.running = { description: 'Go to 10, 64, 5', resume: goto }
      engine.start()
      fight.active = true

      await tick()

      expect(tasks.suspendCalls).toBe(1)
      expect(emitted).toEqual([
        'Paused "Go to 10, 64, 5" for a survival reaction (threat_response).',
      ])
    })

    it('leaves the task alone for a background reflex such as eating', async () => {
      const eat = new ScriptedReflex('auto_eat', 20, false)
      const { engine, tick, tasks } = setup([eat])
      tasks.running = { description: 'Go', resume: goto }
      engine.start()
      eat.active = true

      await tick()

      expect(tasks.suspendCalls).toBe(0)
      expect(tasks.running).toBeDefined()
    })

    it('resumes the task once no reflex wants to act', async () => {
      const fight = new ScriptedReflex('threat_response', 80)
      const { engine, tick, tasks, emitted, resumed } = setup([fight])
      tasks.running = { description: 'Go to 10, 64, 5', resume: goto }
      engine.start()
      fight.active = true
      await tick()

      fight.finish()
      await flush()
      await tick()

      expect(resumed).toEqual([goto])
      expect(emitted.at(-1)).toBe('Resumed "Go to 10, 64, 5".')
      expect(tasks.suspended()).toBeUndefined()
    })

    it('does not resume while a reflex is still running', async () => {
      const fight = new ScriptedReflex('threat_response', 80)
      const { engine, tick, tasks, resumed } = setup([fight])
      tasks.running = { description: 'Go', resume: goto }
      engine.start()
      fight.active = true
      await tick()

      await tick()
      await tick()

      expect(resumed).toEqual([])
    })

    it('does not resume when a reflex says not to (fleeing), and tells the agent to ask the player', async () => {
      const flee = new ScriptedReflex('threat_response', 80)
      flee.outcome = { resumeTask: false }
      const { engine, tick, tasks, emitted, resumed } = setup([flee])
      tasks.running = { description: 'Go to 10, 64, 5', resume: goto }
      engine.start()
      flee.active = true
      await tick()

      flee.finish()
      await flush()
      await tick()

      expect(resumed).toEqual([])
      expect(emitted.at(-1)).toContain('was not resumed')
      expect(emitted.at(-1)).toContain('ask the player')
      expect(tasks.suspended()).toBeUndefined()
    })

    it('does not resume if any reflex in the episode said not to', async () => {
      const lava = new ScriptedReflex('avoid_lava', 100)
      const flee = new ScriptedReflex('threat_response', 80)
      flee.outcome = { resumeTask: false }
      const { engine, tick, tasks, resumed } = setup([lava, flee])
      tasks.running = { description: 'Go', resume: goto }
      engine.start()
      flee.active = true
      await tick()
      flee.finish()
      lava.active = true
      await flush()
      await tick()
      lava.finish()
      await flush()
      await tick()

      expect(resumed).toEqual([])
    })

    it('says so when the task cannot be restarted automatically', async () => {
      const fight = new ScriptedReflex('threat_response', 80)
      const { engine, tick, tasks, emitted, resumed } = setup([fight])
      tasks.running = { description: 'Something custom', resume: undefined }
      engine.start()
      fight.active = true
      await tick()

      fight.finish()
      await flush()
      await tick()

      expect(resumed).toEqual([])
      expect(emitted.at(-1)).toContain('cannot be restarted automatically')
    })

    it('reports when resuming fails', async () => {
      const fight = new ScriptedReflex('threat_response', 80)
      const { engine, tick, tasks, emitted, setResume } = setup([fight])
      tasks.running = { description: 'Go', resume: goto }
      setResume(false)
      engine.start()
      fight.active = true
      await tick()
      fight.finish()
      await flush()

      await tick()

      expect(emitted.at(-1)).toBe('Could not resume "Go"; ask the player what to do.')
    })

    it('has nothing to resume when no task was running', async () => {
      const fight = new ScriptedReflex('threat_response', 80)
      const { engine, tick, resumed, emitted } = setup([fight])
      engine.start()
      fight.active = true
      await tick()
      fight.finish()
      await flush()
      await tick()

      expect(resumed).toEqual([])
      expect(emitted).toEqual([])
    })

    it('resets after an episode: the next reaction may resume again', async () => {
      const flee = new ScriptedReflex('threat_response', 80)
      flee.outcome = { resumeTask: false }
      const { engine, tick, tasks, resumed } = setup([flee])
      engine.start()
      tasks.running = { description: 'first', resume: goto }
      flee.active = true
      await tick()
      flee.finish()
      await flush()
      await tick()

      flee.outcome = { resumeTask: true }
      tasks.running = { description: 'second', resume: goto }
      flee.active = true
      await tick()
      flee.finish()
      await flush()
      await tick()

      expect(resumed).toEqual([goto])
    })
  })

  describe('stopping and failures', () => {
    it('stop aborts the running reflex, forgets any waiting task, and stops ticking', async () => {
      const fight = new ScriptedReflex('threat_response', 80)
      const { engine, tick, tasks, scheduler } = setup([fight])
      tasks.running = { description: 'Go', resume: { tool: 'goto', arguments: {} } }
      engine.start()
      fight.active = true
      await tick()

      await engine.stop()

      expect(fight.aborted).toBe(1)
      expect(tasks.suspended()).toBeUndefined()
      expect(engine.isStarted).toBe(false)
      expect(scheduler.pendingCount).toBe(0)
    })

    it('stop is harmless when nothing runs, and the engine can be started again', async () => {
      const reflex = new ScriptedReflex('eat', 10)
      const { engine, tick } = setup([reflex])
      await engine.stop()
      engine.start()
      reflex.active = true

      await tick()

      expect(reflex.runs).toBe(1)
    })

    it('logs a reflex that crashes, does not resume the task, and keeps going', async () => {
      const fight = new ScriptedReflex('threat_response', 80)
      fight.crashWith = new Error('bug')
      const { engine, tick, tasks, resumed, logger } = setup([fight])
      tasks.running = { description: 'Go', resume: { tool: 'goto', arguments: {} } }
      engine.start()
      fight.active = true
      await tick()

      fight.active = false
      await tick()

      expect(logger.entries.map((e) => e.level)).toContain('error')
      expect(resumed).toEqual([])
      expect(engine.activeReflex()).toBeUndefined()
    })

    it('survives a failing state reading and logs it', async () => {
      const reflex = new ScriptedReflex('eat', 10)
      const { engine, vitals, tick, logger } = setup([reflex])
      engine.start()
      vitals.read = () => {
        throw new Error('sensor failed')
      }

      await tick()
      await tick()

      expect(logger.entries.filter((e) => e.level === 'error')).toHaveLength(2)
    })
  })

  describe('the context handed to reflexes', () => {
    async function contextOf(
      reflex: ScriptedReflex,
      engine: ReflexEngine,
      tick: () => Promise<void>,
    ): Promise<ReflexContext> {
      engine.start()
      reflex.active = true
      await tick()
      const context = reflex.contexts[0]
      if (context === undefined) throw new Error('the reflex did not run')
      return context
    }

    it('emits messages to the agent and reads a fresh state', async () => {
      const reflex = new ScriptedReflex('a', 10, false)
      const { engine, tick, emitted, vitals } = setup([reflex])
      const context = await contextOf(reflex, engine, tick)

      context.emit('hello')
      vitals.vitals = buildVitals({ health: 3 })

      expect(emitted).toEqual(['hello'])
      expect(context.state()?.vitals.health).toBe(3)
      vitals.vitals = undefined
      expect(context.state()).toBeUndefined()
    })

    it('withTimeout aborts after the delay, or when the reflex is aborted, and can be disposed', async () => {
      const reflex = new ScriptedReflex('a', 10, false)
      const { engine, tick, scheduler } = setup([reflex])
      const context = await contextOf(reflex, engine, tick)

      const timed = context.withTimeout(1000)
      expect(timed.signal.aborted).toBe(false)
      scheduler.advance(1000)
      expect(timed.signal.aborted).toBe(true)

      const disposed = context.withTimeout(1000)
      disposed.dispose()
      scheduler.advance(2000)
      expect(disposed.signal.aborted).toBe(false)
    })

    it('withTimeout follows the reflex being aborted', async () => {
      const reflex = new ScriptedReflex('a', 10, false)
      const { engine, tick } = setup([reflex])
      const context = await contextOf(reflex, engine, tick)
      const timed = context.withTimeout(60_000)

      await engine.stop()

      expect(timed.signal.aborted).toBe(true)
    })

    it('sleep and withTimeout on an already aborted reflex end at once, not after the full delay (regression: shutdown stalled)', async () => {
      const reflex = new ScriptedReflex('a', 10, false)
      const { engine, tick } = setup([reflex])
      const context = await contextOf(reflex, engine, tick)
      await engine.stop()
      expect(context.signal.aborted).toBe(true)

      await expect(context.sleep(60_000)).resolves.toBeUndefined()
      expect(context.withTimeout(60_000).signal.aborted).toBe(true)
    })

    it('sleep waits for the delay, and ends early when aborted', async () => {
      const reflex = new ScriptedReflex('a', 10, false)
      const { engine, tick, scheduler } = setup([reflex])
      const context = await contextOf(reflex, engine, tick)
      let slept = false

      void context.sleep(500).then(() => {
        slept = true
      })
      await flush()
      expect(slept).toBe(false)
      scheduler.advance(500)
      await flush()
      expect(slept).toBe(true)

      let woke = false
      void context.sleep(60_000).then(() => {
        woke = true
      })
      await engine.stop()
      await flush()
      expect(woke).toBe(true)
    })
  })
})
