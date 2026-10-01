import { describe, expect, it } from '@jest/globals'
import type { InventoryWriter } from '../../../../src/core/inventory-writer.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { EggThrower } from '../../../../src/skills/farming/egg-thrower.js'
import { FakeGaze } from '../../../fakes/handover-fakes.js'
import { AutoScheduler } from '../../../fakes/gathering-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'

const target: Position = { x: 10, y: 64, z: 10 }

class FakeWriter implements InventoryWriter {
  readonly tosses: { item: string; count: number }[] = []
  /** Throws exactly this many eggs before running out; undefined means never run out. */
  stock: number | undefined

  toss(item: string, count: number): Promise<number> {
    this.tosses.push({ item, count })
    if (this.stock === undefined) return Promise.resolve(count)
    const thrown = Math.min(count, this.stock)
    this.stock -= thrown
    return Promise.resolve(thrown)
  }
}

describe('EggThrower', () => {
  it('looks at the target before every single egg, pausing between throws', async () => {
    const gaze = new FakeGaze()
    const writer = new FakeWriter()
    const clock = new FakeClock()
    const thrower = new EggThrower({ gaze, writer, scheduler: new AutoScheduler(clock) })

    const thrown = await thrower.throw(3, target, new AbortController().signal)

    expect(thrown).toBe(3)
    expect(gaze.looked).toEqual([target, target, target])
    expect(writer.tosses).toEqual([
      { item: 'egg', count: 1 },
      { item: 'egg', count: 1 },
      { item: 'egg', count: 1 },
    ])
  })

  it('stops early once the inventory runs out of eggs', async () => {
    const gaze = new FakeGaze()
    const writer = new FakeWriter()
    writer.stock = 2
    const clock = new FakeClock()
    const thrower = new EggThrower({ gaze, writer, scheduler: new AutoScheduler(clock) })

    const thrown = await thrower.throw(5, target, new AbortController().signal)

    expect(thrown).toBe(2)
    expect(writer.tosses).toHaveLength(3)
  })

  it('stops when aborted, throwing nothing more', async () => {
    const gaze = new FakeGaze()
    const writer = new FakeWriter()
    const clock = new FakeClock()
    const controller = new AbortController()
    controller.abort()
    const thrower = new EggThrower({ gaze, writer, scheduler: new AutoScheduler(clock) })

    const thrown = await thrower.throw(3, target, controller.signal)

    expect(thrown).toBe(0)
    expect(gaze.looked).toEqual([])
    expect(writer.tosses).toEqual([])
  })

  it('throwing zero does nothing', async () => {
    const gaze = new FakeGaze()
    const writer = new FakeWriter()
    const clock = new FakeClock()
    const thrower = new EggThrower({ gaze, writer, scheduler: new AutoScheduler(clock) })

    const thrown = await thrower.throw(0, target, new AbortController().signal)

    expect(thrown).toBe(0)
    expect(gaze.looked).toEqual([])
  })
})
