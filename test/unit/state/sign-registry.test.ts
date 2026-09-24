import { beforeEach, describe, expect, it } from '@jest/globals'
import { SignRegistry } from '../../../src/state/sign-registry.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { InMemoryStateStore } from '../../fakes/state-fakes.js'

const at = (x: number) => ({ x, y: 64, z: 3 })

describe('SignRegistry', () => {
  let store: InMemoryStateStore
  let registry: SignRegistry

  beforeEach(async () => {
    store = new InMemoryStateStore()
    registry = new SignRegistry(new FakeClock(0))
    await registry.attach(store)
  })

  it('remembers the signs it put up, once per place', () => {
    registry.note(at(1), { lines: ['Iron'], side: 'front', wood: 'oak' })
    const again = registry.note(at(1), { lines: ['Ores'], side: 'front', wood: 'oak' })
    registry.note(at(2), { lines: ['Farm'], side: 'front', wood: 'spruce' })

    expect(registry.all()).toHaveLength(2)
    expect(again.ok && again.value.lines).toEqual(['Ores'])
    expect(registry.at(at(2))).toMatchObject({
      wood: 'spruce',
      placedAt: '1970-01-01T00:00:00.000Z',
    })
    expect(registry.at(at(9))).toBeUndefined()
  })

  it('changes the recorded text of a sign it knows and ignores others', () => {
    registry.note(at(1), { lines: ['Iron'], side: 'front', wood: 'oak' })

    registry.retext(at(1), 'back', ['Back'])
    registry.retext(at(7), 'front', ['Nope'])

    expect(registry.at(at(1))).toMatchObject({ side: 'back', lines: ['Back'] })
    expect(registry.all()).toHaveLength(1)
  })

  it('forgets a sign that was taken down', () => {
    registry.note(at(1), { lines: ['Iron'], side: 'front', wood: 'oak' })

    expect(registry.remove(at(1))).toBe(true)
    expect(registry.remove(at(1))).toBe(false)
    expect(registry.all()).toEqual([])
  })

  it('survives a reload and gives every sign its own id', async () => {
    registry.note(at(1), { lines: ['Iron'], side: 'front', wood: 'oak' })
    registry.remove(at(1))
    registry.note(at(2), { lines: ['Farm'], side: 'front', wood: 'oak' })
    await store.flush()

    const reloaded = new SignRegistry(new FakeClock(0))
    await reloaded.attach(store)

    expect(reloaded.all().map((sign) => sign.id)).toEqual(['sign-2'])
  })

  it('refuses to record without a world', () => {
    const detached = new SignRegistry(new FakeClock(0))

    const result = detached.note(at(1), { lines: ['x'], side: 'front', wood: 'oak' })

    expect(result.ok).toBe(false)
    expect(detached.remove(at(1))).toBe(false)
  })
})
