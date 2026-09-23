import { describe, expect, it } from '@jest/globals'
import { EggPolicy } from '../../../src/state/egg-policy.js'
import { FarmRegistry, MAX_FARMS } from '../../../src/state/farm-registry.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { InMemoryStateStore } from '../../fakes/state-fakes.js'

async function registry(store = new InMemoryStateStore()) {
  const farms = new FarmRegistry(new FakeClock(Date.UTC(2026, 8, 19, 12)))
  await farms.attach(store)
  return { farms, store }
}

const bounds = (x0: number, z0: number, x1: number, z1: number) => ({
  from: { x: x0, y: 64, z: z0 },
  to: { x: x1, y: 66, z: z1 },
})

describe('FarmRegistry', () => {
  it('registers a farm and remembers it under an id', async () => {
    const { farms } = await registry()

    const entry = farms.register({
      kind: 'field',
      crop: 'wheat',
      bounds: bounds(0, 0, 8, 8),
      label: 'home field',
      group: 'home',
      builtByBot: true,
    })

    expect(entry).toMatchObject({
      ok: true,
      value: {
        id: 'farm-1',
        kind: 'field',
        crop: 'wheat',
        label: 'home field',
        group: 'home',
        builtByBot: true,
      },
    })
    expect(farms.resolve('home field')?.id).toBe('farm-1')
    expect(farms.resolve('HOME FIELD')?.id).toBe('farm-1')
    expect(farms.resolve('farm-1')?.label).toBe('home field')
  })

  it('defaults crop, label, and group to null when not given', async () => {
    const { farms } = await registry()

    const entry = farms.register({ kind: 'field', bounds: bounds(0, 0, 2, 2), builtByBot: false })

    expect(entry).toMatchObject({
      ok: true,
      value: { crop: null, label: null, group: null, builtByBot: false },
    })
  })

  it('refuses a label already used by another farm', async () => {
    const { farms } = await registry()
    farms.register({ kind: 'field', bounds: bounds(0, 0, 2, 2), label: 'field a' })

    const again = farms.register({ kind: 'field', bounds: bounds(3, 3, 5, 5), label: 'field a' })

    expect(again).toMatchObject({ ok: false })
    expect(farms.all()).toHaveLength(1)
  })

  it('groups several components and resolves them together', async () => {
    const { farms } = await registry()
    farms.register({ kind: 'field', bounds: bounds(0, 0, 2, 2), group: 'home', crop: 'wheat' })
    farms.register({ kind: 'pen', bounds: bounds(3, 3, 5, 5), group: 'home' })
    farms.register({ kind: 'field', bounds: bounds(6, 6, 8, 8), group: 'other' })

    const home = farms.byGroup('Home')

    expect(home).toHaveLength(2)
    expect(home.map((f) => f.kind).sort()).toEqual(['field', 'pen'])
  })

  it('removes a farm', async () => {
    const { farms } = await registry()
    const entry = farms.register({ kind: 'field', bounds: bounds(0, 0, 2, 2) })
    if (!entry.ok) throw new Error(entry.error)

    const removed = farms.remove(entry.value.id)

    expect(removed).toEqual({ ok: true, value: entry.value })
    expect(farms.all()).toHaveLength(0)
  })

  it('refuses to remove an unknown farm', async () => {
    const { farms } = await registry()

    expect(farms.remove('farm-9')).toMatchObject({ ok: false })
  })

  it('fails every operation before a world is active', () => {
    const farms = new FarmRegistry(new FakeClock(0))

    expect(farms.register({ kind: 'field', bounds: bounds(0, 0, 1, 1) })).toMatchObject({ ok: false })
    expect(farms.list()).toMatchObject({ ok: false })
    expect(farms.all()).toEqual([])
  })

  it('refuses past the farm limit', async () => {
    const { farms } = await registry()
    for (let i = 0; i < MAX_FARMS; i += 1) farms.register({ kind: 'field', bounds: bounds(i, 0, i, 1) })

    const over = farms.register({ kind: 'field', bounds: bounds(999, 0, 999, 1) })

    expect(over).toMatchObject({ ok: false })
    expect(farms.all()).toHaveLength(MAX_FARMS)
  })

  it('persists across a reattach to the same store', async () => {
    const store = new InMemoryStateStore()
    const first = await registry(store)
    first.farms.register({ kind: 'field', bounds: bounds(0, 0, 2, 2), label: 'wheat' })

    const second = await registry(store)

    expect(second.farms.all()).toHaveLength(1)
    expect(second.farms.byLabel('wheat')).toBeDefined()
  })

  it('registers a pen with a species and a herd target', async () => {
    const { farms } = await registry()

    const entry = farms.register({
      kind: 'pen',
      species: 'cow',
      herdTarget: 8,
      bounds: bounds(0, 0, 4, 4),
      label: 'cow pen',
    })

    expect(entry).toMatchObject({ ok: true, value: { species: 'cow', herdTarget: 8, crop: null } })
  })

  it('defaults species and herdTarget to null when not given', async () => {
    const { farms } = await registry()

    const entry = farms.register({ kind: 'field', bounds: bounds(0, 0, 2, 2) })

    expect(entry).toMatchObject({ ok: true, value: { species: null, herdTarget: null } })
  })

  it('migrates a version-1 document (from before species/herdTarget existed)', async () => {
    const store = new InMemoryStateStore()
    store.files.set('farms', {
      version: 1,
      data: {
        farms: [
          {
            id: 'farm-1',
            kind: 'field',
            crop: 'wheat',
            bounds: bounds(0, 0, 2, 2),
            label: 'old field',
            group: null,
            builtByBot: true,
            registeredAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        nextId: 2,
      },
    })

    const { farms } = await registry(store)

    expect(farms.all()).toEqual([
      {
        id: 'farm-1',
        kind: 'field',
        crop: 'wheat',
        species: null,
        herdTarget: null,
        bounds: bounds(0, 0, 2, 2),
        label: 'old field',
        group: null,
        builtByBot: true,
        registeredAt: '2026-01-01T00:00:00.000Z',
      },
    ])
  })
})

describe('EggPolicy', () => {
  it('defaults to storing a tenth and releasing the rest to hatch, and saves changes', async () => {
    const store = new InMemoryStateStore()
    const policy = new EggPolicy()
    await policy.attach(store)

    expect(policy.get()).toEqual({ storeFraction: 0.1, release: 'hatch' })
    expect(policy.set({ storeFraction: 0.5, release: 'store' })).toMatchObject({ ok: true })

    const reloaded = new EggPolicy()
    await reloaded.attach(store)
    expect(reloaded.get()).toEqual({ storeFraction: 0.5, release: 'store' })
  })

  it('cannot be set without a world, and falls back to the default', async () => {
    const policy = new EggPolicy()
    expect(policy.set({ storeFraction: 1, release: 'store' }).ok).toBe(false)
    await policy.attach(new InMemoryStateStore())
    policy.set({ storeFraction: 1, release: 'store' })

    policy.detach()

    expect(policy.get()).toEqual({ storeFraction: 0.1, release: 'hatch' })
    const store = new InMemoryStateStore()
    store.warnOnLoad = 'recovered'
    expect(await new EggPolicy().attach(store)).toEqual(['recovered'])
  })
})
