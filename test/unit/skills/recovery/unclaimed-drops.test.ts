import { describe, expect, it } from '@jest/globals'
import {
  UNCLAIMED_WAIT_MS,
  UnclaimedDropHandler,
  type UnclaimedDrop,
} from '../../../../src/skills/recovery/unclaimed-drops.js'
import { DropRecords } from '../../../../src/state/drop-records.js'
import { DropRecoveryPolicy } from '../../../../src/state/drop-recovery-policy.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const START = 1_000_000

async function setup(attached = true) {
  const clock = new FakeClock(START)
  const scheduler = new FakeScheduler(clock)
  const records = new DropRecords(clock)
  const policy = new DropRecoveryPolicy()
  if (attached) {
    const store = new InMemoryStateStore()
    await records.attach(store)
    await policy.attach(store)
  }
  const events: { type: string; message: string }[] = []
  const started: string[] = []
  const handler = new UnclaimedDropHandler({
    records,
    policy,
    recovery: {
      start: (id) => {
        started.push(id)
        return Promise.resolve()
      },
    },
    emit: (type, message) => {
      events.push({ type, message })
    },
    waitMs: UNCLAIMED_WAIT_MS,
    clock,
    scheduler,
  })
  return { clock, scheduler, records, policy, events, started, handler }
}

const drop = (patch: Partial<UnclaimedDrop> = {}): UnclaimedDrop => ({
  items: [{ name: 'iron_ingot', count: 5 }],
  position: { x: 10.4, y: 64, z: 3.6 },
  dimension: 'overworld',
  at: START - 10_000,
  player: 'Andrey_Knight',
  recollect: undefined,
  ...patch,
})

describe('UnclaimedDropHandler', () => {
  it('takes the items back a minute after the drop, and tells the agent', async () => {
    const s = await setup()

    s.handler.track(drop())

    expect(s.records.all()).toMatchObject([
      { kind: 'unclaimed', status: 'pending', lost: [{ name: 'iron_ingot', count: 5 }] },
    ])
    expect(s.events[0]?.message).toContain('Nobody picked up 5 iron_ingot thrown for Andrey_Knight')
    expect(s.events[0]?.message).toContain('10, 64, 4')
    expect(s.started).toEqual([])
    s.scheduler.advance(UNCLAIMED_WAIT_MS - 10_000 - 1)
    expect(s.started).toEqual([])
    s.scheduler.advance(1)
    expect(s.started).toEqual(['drop-1'])
  })

  it('leaves the items on the ground when the standing policy says skip, keeping the coordinates', async () => {
    const s = await setup()
    s.policy.set({ unclaimed: 'skip' })

    s.handler.track(drop())
    s.scheduler.advance(UNCLAIMED_WAIT_MS)

    expect(s.records.all()[0]).toMatchObject({
      status: 'abandoned',
      note: 'Left on the ground on purpose.',
    })
    expect(s.started).toEqual([])
    expect(s.events[0]?.message).toContain('leaves them there as told')
  })

  it('lets the call override the policy in both directions', async () => {
    const skipping = await setup()
    skipping.policy.set({ unclaimed: 'skip' })
    skipping.handler.track(drop({ recollect: true }))
    skipping.scheduler.advance(UNCLAIMED_WAIT_MS)
    expect(skipping.started).toEqual(['drop-1'])

    const auto = await setup()
    auto.handler.track(drop({ recollect: false }))
    auto.scheduler.advance(UNCLAIMED_WAIT_MS)
    expect(auto.started).toEqual([])
    expect(auto.records.all()[0]?.status).toBe('abandoned')
  })

  it('is not affected by the death policy', async () => {
    const s = await setup()
    s.policy.set({ death: 'skip' })

    s.handler.track(drop())
    s.scheduler.advance(UNCLAIMED_WAIT_MS)

    expect(s.started).toEqual(['drop-1'])
  })

  it('starts at once when the minute is already over', async () => {
    const s = await setup()

    s.handler.track(drop({ at: START - 120_000 }))
    s.scheduler.advance(0)

    expect(s.started).toEqual(['drop-1'])
  })

  it('does nothing without an active world', async () => {
    const s = await setup(false)

    s.handler.track(drop())
    s.scheduler.advance(UNCLAIMED_WAIT_MS)

    expect(s.events).toEqual([])
    expect(s.started).toEqual([])
  })
})
