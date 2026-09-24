import { beforeEach, describe, expect, it } from '@jest/globals'
import { BedRegistry } from '../../../src/state/bed-registry.js'
import { SleepPolicy } from '../../../src/state/sleep-policy.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { InMemoryStateStore } from '../../fakes/state-fakes.js'

const at = (x: number, z = 0) => ({ x, y: 64, z })

describe('BedRegistry', () => {
  let store: InMemoryStateStore
  let registry: BedRegistry

  beforeEach(async () => {
    store = new InMemoryStateStore()
    registry = new BedRegistry(new FakeClock(0))
    await registry.attach(store)
  })

  it('remembers a bed once, whichever of its two halves is noted', () => {
    const first = registry.note(at(5), 'red')
    const second = registry.note(at(6), 'red')

    expect(first.ok && second.ok && first.value.id === second.value.id).toBe(true)
    expect(registry.all()).toHaveLength(1)
    expect(registry.note(at(9), 'blue').ok).toBe(true)
    expect(registry.all()).toHaveLength(2)
  })

  it('has one respawn point at a time and moves it when another bed is used', () => {
    registry.setRespawn(at(1), 'red')
    registry.setRespawn(at(9), 'blue')

    expect(registry.all().filter((b) => b.respawn)).toHaveLength(1)
    expect(registry.respawn()).toMatchObject({ x: 9, colour: 'blue', intact: true })
    expect(registry.respawn()?.setAt).toBe('1970-01-01T00:00:00.000Z')
  })

  it('marks a lost bed and keeps it out of the nearest list', () => {
    const bed = registry.setRespawn(at(1), 'red')
    registry.note(at(20), 'blue')
    if (!bed.ok) throw new Error('no bed')

    const lost = registry.markLost(bed.value.id)

    expect(lost).toMatchObject({ respawn: false, intact: false })
    expect(registry.respawn()).toBeUndefined()
    expect(registry.nearest(at(0)).map((b) => b.colour)).toEqual(['blue'])
    expect(registry.markLost('bed-99')).toBeUndefined()
  })

  it('lists intact beds nearest first, and forgets a removed one', () => {
    registry.note(at(30), 'red')
    const near = registry.note(at(3), 'blue')
    expect(registry.nearest(at(0)).map((b) => b.colour)).toEqual(['blue', 'red'])
    if (!near.ok) throw new Error('no bed')

    expect(registry.remove(near.value.id)).toBe(true)
    expect(registry.remove(near.value.id)).toBe(false)
    expect(registry.all()).toHaveLength(1)
  })

  it('persists per world and refuses without one', async () => {
    registry.setRespawn(at(1), 'red')
    const again = new BedRegistry(new FakeClock(0))
    await again.attach(store)
    expect(again.respawn()).toMatchObject({ x: 1 })

    again.detach()
    expect(again.note(at(2), 'red')).toEqual({ ok: false, error: expect.stringContaining('No world') })
    expect(again.markLost('bed-1')).toBeUndefined()
    expect(again.remove('bed-1')).toBe(false)
    expect(again.all()).toEqual([])
  })
})

describe('SleepPolicy', () => {
  it('defaults to ask, saves a choice, and forgets it on detach', async () => {
    const store = new InMemoryStateStore()
    const policy = new SleepPolicy()
    expect(policy.set('never').ok).toBe(false)
    await policy.attach(store)
    expect(policy.get()).toBe('ask')

    expect(policy.set('when_idle').ok).toBe(true)
    const again = new SleepPolicy()
    await again.attach(store)
    expect(again.get()).toBe('when_idle')

    again.detach()
    expect(again.get()).toBe('ask')
  })
})
