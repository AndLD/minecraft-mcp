import { describe, expect, it } from '@jest/globals'
import { SmeltJobWatcher } from '../../../../src/skills/smelting/smelt-job-watcher.js'
import { SmeltJobs, type SmeltJob } from '../../../../src/state/smelt-jobs.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeVitals, buildVitals } from '../../../fakes/fake-ports.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const START = 1_000_000

const job = (over: Partial<SmeltJob> = {}): SmeltJob => ({
  x: 10,
  y: 64,
  z: -3,
  item: 'raw_iron',
  produced: 'iron_ingot',
  count: 6, // a minute
  loaded: 6,
  collected: 0,
  fuel: 'coal',
  startedAt: START,
  dimension: 'overworld',
  detached: true,
  readyNotified: false,
  ...over,
})

async function setup() {
  const clock = new FakeClock(START)
  const scheduler = new FakeScheduler(clock)
  const jobs = new SmeltJobs()
  const store = new InMemoryStateStore()
  await jobs.attach(store)
  const vitals = new FakeVitals()
  vitals.vitals = buildVitals({ position: { x: 10.5, y: 64, z: -3.5 } })
  const events: { type: string; message: string }[] = []
  const watcher = new SmeltJobWatcher({
    jobs,
    clock,
    scheduler,
    vitals,
    emit: (type, message) => {
      events.push({ type, message })
    },
  })
  watcher.start()
  return { clock, scheduler, jobs, store, vitals, events, watcher }
}

describe('SmeltJobWatcher', () => {
  it('says a left job should be done when its time is up, and not before', async () => {
    const s = await setup()
    s.jobs.put(job())

    s.scheduler.advance(59_000)
    expect(s.events).toEqual([])
    s.scheduler.advance(1_000)

    expect(s.events).toHaveLength(1)
    expect(s.events[0]?.type).toBe('smelt_ready')
    expect(s.events[0]?.message).toContain('10 64 -3')
    expect(s.events[0]?.message).toContain('6 raw_iron into iron_ingot')
    expect(s.events[0]?.message).toContain('collect: true')
  })

  it('says it once, and remembers that it did', async () => {
    const s = await setup()
    s.jobs.put(job())

    s.scheduler.advance(120_000)

    expect(s.events).toHaveLength(1)
    expect(s.jobs.all()).toMatchObject([{ readyNotified: true }])
    s.scheduler.advance(600_000)
    expect(s.events).toHaveLength(1)
  })

  it('does not watch a job that a smelt task is waiting for', async () => {
    const s = await setup()
    s.jobs.put(job({ detached: false }))

    s.scheduler.advance(600_000)

    expect(s.events).toEqual([])
  })

  it('starts watching when a job is left, and stops when it is collected', async () => {
    const s = await setup()
    s.jobs.put(job({ detached: false }))
    s.jobs.update({ x: 10, y: 64, z: -3 }, { detached: true })

    s.scheduler.advance(30_000)
    s.jobs.remove({ x: 10, y: 64, z: -3 })
    s.scheduler.advance(120_000)

    expect(s.events).toEqual([])
    expect(s.scheduler.pendingCount).toBe(0)
  })

  it('says at once when the time was up while the bot was away (a restart)', async () => {
    const s = await setup()
    s.jobs.put(job())
    s.watcher.dispose()
    s.clock.advance(3_600_000) // an hour later
    const again = new SmeltJobs()
    const events: string[] = []
    new SmeltJobWatcher({
      jobs: again,
      clock: s.clock,
      scheduler: s.scheduler,
      vitals: s.vitals,
      emit: (_type, message) => {
        events.push(message)
      },
    }).start()
    await again.attach(s.store)

    s.scheduler.advance(0)

    expect(events).toHaveLength(1)
  })

  it('watches several jobs, each at its own time', async () => {
    const s = await setup()
    s.jobs.put(job({ item: 'raw_iron', count: 3 })) // 30 seconds
    s.jobs.put(job({ x: 20, item: 'beef', produced: 'cooked_beef', count: 9 })) // 90 seconds

    s.scheduler.advance(30_000)
    expect(s.events).toHaveLength(1)
    s.scheduler.advance(60_000)

    expect(s.events).toHaveLength(2)
    expect(s.events[1]?.message).toContain('beef')
  })

  it('mentions a furnace that is far away', async () => {
    const s = await setup()
    s.vitals.vitals = buildVitals({ position: { x: 210, y: 64, z: -3 } })
    s.jobs.put(job())

    s.scheduler.advance(60_000)

    expect(s.events[0]?.message).toContain('about 200 blocks away')
  })

  it('does not mention a furnace that is near', async () => {
    const s = await setup()
    s.jobs.put(job())

    s.scheduler.advance(60_000)

    expect(s.events[0]?.message).not.toContain('blocks away')
  })

  it('mentions a furnace in another dimension', async () => {
    const s = await setup()
    s.vitals.vitals = buildVitals({ dimension: 'minecraft:the_nether' })
    s.jobs.put(job())

    s.scheduler.advance(60_000)

    expect(s.events[0]?.message).toContain('in the overworld, and the bot is in the the_nether')
  })

  it('says nothing about where the furnace is while the bot is not connected', async () => {
    const s = await setup()
    s.vitals.vitals = undefined
    s.jobs.put(job())

    s.scheduler.advance(60_000)

    expect(s.events).toHaveLength(1)
    expect(s.events[0]?.message).not.toContain('blocks away')
  })

  it('stops watching when disposed, and starts only once', async () => {
    const s = await setup()
    s.watcher.start() // already started: nothing doubles
    s.jobs.put(job())
    s.watcher.dispose()

    s.scheduler.advance(600_000)

    expect(s.events).toEqual([])
  })

  it('does not send a signal for a job that was collected between the timer and the announcement', async () => {
    const s = await setup()
    s.jobs.put(job())
    s.jobs.update({ x: 10, y: 64, z: -3 }, { readyNotified: true })

    s.scheduler.advance(600_000)

    expect(s.events).toEqual([])
  })
})
