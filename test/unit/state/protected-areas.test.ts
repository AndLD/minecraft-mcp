import { describe, expect, it } from '@jest/globals'
import { ProtectedAreas } from '../../../src/state/protected-areas.js'
import { InMemoryStateStore } from '../../fakes/state-fakes.js'

async function attached(store = new InMemoryStateStore()) {
  const areas = new ProtectedAreas()
  await areas.attach(store)
  return { areas, store }
}

describe('ProtectedAreas', () => {
  it('protects the box between two corners, whichever order they come in', async () => {
    const { areas } = await attached()

    const added = areas.add('my house', { x: 10, y: 70, z: 5 }, { x: 0, y: 60, z: -5 })

    expect(added).toEqual({
      ok: true,
      value: {
        id: 'area-1',
        label: 'my house',
        min: { x: 0, y: 60, z: -5 },
        max: { x: 10, y: 70, z: 5 },
      },
    })
  })

  it('knows which positions are inside, edges included, fractions floored', async () => {
    const { areas } = await attached()
    areas.add('house', { x: 0, y: 60, z: 0 }, { x: 10, y: 70, z: 10 })

    expect(areas.protectedAt({ x: 0, y: 60, z: 0 })).toEqual({ id: 'area-1', label: 'house' })
    expect(areas.protectedAt({ x: 10.9, y: 70.5, z: 10.2 })).toBeDefined()
    expect(areas.protectedAt({ x: 11, y: 65, z: 5 })).toBeUndefined()
    expect(areas.protectedAt({ x: 5, y: 71, z: 5 })).toBeUndefined()
    expect(areas.protectedAt({ x: -0.5, y: 65, z: 5 })).toBeUndefined()
  })

  it('lists and removes areas', async () => {
    const { areas } = await attached()
    areas.add('a', { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 })
    areas.add('b', { x: 5, y: 5, z: 5 }, { x: 6, y: 6, z: 6 })

    expect(areas.remove('area-1')).toMatchObject({ ok: true, value: { label: 'a' } })

    const list = areas.list()
    expect(list.ok && list.value.map((a) => a.id)).toEqual(['area-2'])
    expect(areas.protectedAt({ x: 0, y: 0, z: 0 })).toBeUndefined()
    expect(areas.remove('area-9')).toEqual({
      ok: false,
      error: 'There is no protected area area-9.',
    })
  })

  it('needs a label', async () => {
    const { areas } = await attached()

    expect(areas.add('  ', { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 })).toMatchObject({
      ok: false,
      error: expect.stringContaining('label') as unknown as string,
    })
  })

  it('keeps a bounded number of areas', async () => {
    const { areas } = await attached()
    for (let i = 0; i < 100; i += 1)
      areas.add(`a${String(i)}`, { x: i, y: 0, z: 0 }, { x: i, y: 0, z: 0 })

    expect(areas.add('one more', { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toMatchObject({
      ok: false,
      error: expect.stringContaining('100') as unknown as string,
    })
  })

  it('saves what changes and loads it again', async () => {
    const { areas, store } = await attached()
    areas.add('house', { x: 0, y: 60, z: 0 }, { x: 4, y: 64, z: 4 })

    const { areas: reloaded } = await attached(store)

    expect(reloaded.protectedAt({ x: 2, y: 62, z: 2 })).toEqual({ id: 'area-1', label: 'house' })
    expect(reloaded.add('next', { x: 9, y: 9, z: 9 }, { x: 9, y: 9, z: 9 })).toMatchObject({
      ok: true,
      value: { id: 'area-2' },
    })
  })

  it('passes on a warning from loading', async () => {
    const store = new InMemoryStateStore()
    store.warnOnLoad = 'recovered from backup'

    const warnings = await new ProtectedAreas().attach(store)

    expect(warnings).toEqual(['recovered from backup'])
  })

  it('does nothing without an active world', async () => {
    const { areas } = await attached()
    areas.add('house', { x: 0, y: 0, z: 0 }, { x: 4, y: 4, z: 4 })

    areas.detach()

    expect(areas.protectedAt({ x: 1, y: 1, z: 1 })).toBeUndefined()
    expect(areas.add('x', { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }).ok).toBe(false)
    expect(areas.remove('area-1').ok).toBe(false)
    expect(areas.list().ok).toBe(false)
  })
})
