import { describe, expect, it } from '@jest/globals'
import type { Reflex, ReflexOutcome } from '../../../src/reflexes/reflex.types.js'
import { ReflexEngine } from '../../../src/reflexes/reflex-engine.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { FakeLogger } from '../../fakes/fake-logger.js'
import { buildVitals, FakeEntityScanner, FakeVitals } from '../../fakes/fake-ports.js'
import { FakeScheduler } from '../../fakes/fake-scheduler.js'
import { FakeSleeper } from '../../fakes/sleeping-fakes.js'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

class Wanting implements Reflex {
  runs = 0
  constructor(
    readonly name: string,
    readonly preemptsTask: boolean,
    private readonly log: string[],
  ) {}
  readonly priority = 50
  wants(): boolean {
    return this.runs === 0
  }
  run(): Promise<ReflexOutcome> {
    this.runs += 1
    this.log.push(`run ${this.name}`)
    return Promise.resolve({ resumeTask: true })
  }
}

async function run(preemptsTask: boolean, sleeping: boolean) {
  const log: string[] = []
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const vitals = new FakeVitals()
  vitals.vitals = buildVitals()
  const sleeper = new FakeSleeper()
  sleeper.sleeping = sleeping
  const realWake = sleeper.wake.bind(sleeper)
  sleeper.wake = async () => {
    log.push('wake')
    await realWake()
  }
  const engine = new ReflexEngine({
    reflexes: [new Wanting('threat', preemptsTask, log)],
    vitals,
    entities: new FakeEntityScanner(),
    tasks: {
      suspend: () => Promise.resolve(undefined),
      takeSuspended: () => undefined,
      suspended: () => undefined,
    },
    resume: () => Promise.resolve(true),
    sleeper,
    emit: () => undefined,
    scheduler,
    clock,
    logger: new FakeLogger(),
  })
  engine.start()
  scheduler.advance(250)
  await flush()
  await engine.stop()
  return log
}

describe('ReflexEngine and a sleeping bot', () => {
  it('wakes the bot before a reflex that moves it acts', async () => {
    expect(await run(true, true)).toEqual(['wake', 'run threat'])
  })

  it('does not wake a bot that is up, nor for a reflex that does not move it', async () => {
    expect(await run(true, false)).toEqual(['run threat'])
    expect(await run(false, true)).toEqual(['run threat'])
  })
})
