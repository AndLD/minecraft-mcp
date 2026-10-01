import { describe, expect, it } from '@jest/globals'
import { countItems, describeItems, gained } from '../../../src/core/inventory-counts.js'
import { sleep } from '../../../src/core/sleep.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { FakeScheduler } from '../../fakes/fake-scheduler.js'

describe('inventory counts', () => {
  it('adds up stacks of the same item', () => {
    const counts = countItems({
      stacks: [
        { name: 'oak_log', count: 64 },
        { name: 'oak_log', count: 3 },
        { name: 'stick', count: 2 },
      ],
      emptySlots: 30,
      heldItem: undefined,
    })

    expect(counts.get('oak_log')).toBe(67)
    expect(counts.get('stick')).toBe(2)
  })

  it('counts nothing while not connected', () => {
    expect(countItems(undefined).size).toBe(0)
  })

  it('reports gains, biggest first, and ignores losses', () => {
    const before = new Map([
      ['oak_planks', 8],
      ['coal', 2],
    ])
    const after = new Map([
      ['oak_planks', 4],
      ['coal', 5],
      ['stick', 4],
      ['iron_ingot', 4],
    ])

    expect(gained(before, after)).toEqual([
      { name: 'iron_ingot', count: 4 },
      { name: 'stick', count: 4 },
      { name: 'coal', count: 3 },
    ])
  })

  it('describes items in words', () => {
    expect(
      describeItems([
        { name: 'oak_log', count: 3 },
        { name: 'stick', count: 2 },
      ]),
    ).toBe('3 oak_log, 2 stick')
    expect(describeItems([])).toBe('nothing')
  })
})

describe('sleep', () => {
  it('resolves after the delay', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeScheduler(clock)
    let done = false

    const waiting = sleep(scheduler, 500, new AbortController().signal).then(() => {
      done = true
    })
    scheduler.advance(499)
    await Promise.resolve()
    expect(done).toBe(false)
    scheduler.advance(1)
    await waiting

    expect(done).toBe(true)
  })

  it('resolves at once when aborted while waiting, and drops the timer', async () => {
    const scheduler = new FakeScheduler(new FakeClock())
    const controller = new AbortController()

    const waiting = sleep(scheduler, 60_000, controller.signal)
    controller.abort()
    await waiting

    expect(scheduler.pendingCount).toBe(0)
  })

  it('does not wait when the signal is already aborted', async () => {
    const scheduler = new FakeScheduler(new FakeClock())
    const controller = new AbortController()
    controller.abort()

    await sleep(scheduler, 60_000, controller.signal)

    expect(scheduler.pendingCount).toBe(0)
  })
})
