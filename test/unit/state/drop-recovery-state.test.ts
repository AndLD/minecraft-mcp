import { describe, expect, it } from '@jest/globals'
import { DROP_DESPAWN_MS, DropRecords } from '../../../src/state/drop-records.js'
import { DropRecoveryPolicy } from '../../../src/state/drop-recovery-policy.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { InMemoryStateStore } from '../../fakes/state-fakes.js'

const newDeath = (at: number, extra: object = {}) => ({
  kind: 'death' as const,
  position: { x: 1, y: 64, z: 2 },
  dimension: 'overworld',
  at,
  cause: null,
  lost: [{ name: 'iron_ingot', count: 5 }],
  note: null,
  ...extra,
})

async function records(store = new InMemoryStateStore(), clock = new FakeClock(0)) {
  const drops = new DropRecords(clock)
  await drops.attach(store)
  return { drops, store, clock }
}

describe('DropRecords', () => {
  it('numbers records and saves them with the coordinates', async () => {
    const { drops, store } = await records()

    const first = drops.add(newDeath(1000))
    const second = drops.add(newDeath(2000))

    expect(first).toMatchObject({
      ok: true,
      value: { id: 'drop-1', status: 'pending', attempts: 0 },
    })
    expect(second).toMatchObject({ ok: true, value: { id: 'drop-2' } })
    expect(store.files.get('drop-records')).toBeDefined()
  })

  it('survives a relaunch: a new instance reads the same records', async () => {
    const { drops, store } = await records()
    drops.add(newDeath(1000, { cause: 'fell from a high place' }))
    drops.update('drop-1', { status: 'partial', attempts: 1 })

    const { drops: reloaded } = await records(store)

    expect(reloaded.all()).toMatchObject([
      { id: 'drop-1', status: 'partial', attempts: 1, cause: 'fell from a high place' },
    ])
    expect(reloaded.add(newDeath(3000))).toMatchObject({ value: { id: 'drop-2' } })
  })

  it('cannot save without an active world', () => {
    const drops = new DropRecords(new FakeClock(0))

    expect(drops.add(newDeath(0))).toMatchObject({ ok: false })
  })

  it('lists what can still be fetched, newest first, and hides the rest', async () => {
    const { drops } = await records()
    drops.add(newDeath(0))
    drops.add(newDeath(0))
    drops.add(newDeath(0))
    drops.update('drop-1', { status: 'recovered' })
    drops.update('drop-3', { status: 'recovering' })

    expect(drops.recoverable().map((r) => r.id)).toEqual(['drop-2'])
    expect(drops.recovering().map((r) => r.id)).toEqual(['drop-3'])
  })

  it('marks records expired once the items would have despawned', async () => {
    const { drops, clock } = await records()
    drops.add(newDeath(0))
    drops.add(newDeath(100_000, { status: 'abandoned' }))

    clock.advance(DROP_DESPAWN_MS)
    drops.expireStale()

    expect(drops.all().map((r) => r.status)).toEqual(['expired', 'abandoned'])
    clock.advance(100_000)
    expect(drops.recoverable()).toEqual([])
  })

  it('keeps only the newest 50 records', async () => {
    const { drops } = await records()
    for (let i = 0; i < 55; i += 1) drops.add(newDeath(i))

    expect(drops.all()).toHaveLength(50)
    expect(drops.all()[0]?.id).toBe('drop-6')
  })

  it('ignores an update for an unknown record', async () => {
    const { drops } = await records()

    expect(drops.update('drop-9', { status: 'gone' })).toBeUndefined()
  })

  it('starts empty and forgets everything when detached', async () => {
    const { drops } = await records()
    drops.add(newDeath(0))

    drops.detach()

    expect(drops.all()).toEqual([])
  })

  it('reports a recovered corrupt file as a warning', async () => {
    const store = new InMemoryStateStore()
    store.warnOnLoad = 'recovered'

    expect(await new DropRecords(new FakeClock(0)).attach(store)).toEqual(['recovered'])
  })
})

describe('DropRecoveryPolicy', () => {
  it('recovers by default, in both situations', async () => {
    const policy = new DropRecoveryPolicy()
    await policy.attach(new InMemoryStateStore())

    expect(policy.get()).toEqual({ death: 'auto', unclaimed: 'auto' })
    expect(policy.forKind('death')).toBe('auto')
  })

  it('sets one situation without touching the other, and saves it', async () => {
    const store = new InMemoryStateStore()
    const policy = new DropRecoveryPolicy()
    await policy.attach(store)

    expect(policy.set({ unclaimed: 'skip' })).toMatchObject({
      ok: true,
      value: { death: 'auto', unclaimed: 'skip' },
    })

    const reloaded = new DropRecoveryPolicy()
    await reloaded.attach(store)
    expect(reloaded.get()).toEqual({ death: 'auto', unclaimed: 'skip' })
  })

  it('cannot be set without a world, and resets when detached', async () => {
    const policy = new DropRecoveryPolicy()
    expect(policy.set({ death: 'skip' })).toMatchObject({ ok: false })

    await policy.attach(new InMemoryStateStore())
    policy.set({ death: 'skip' })
    policy.detach()

    expect(policy.get().death).toBe('auto')
  })

  it('reports a recovered corrupt file as a warning', async () => {
    const store = new InMemoryStateStore()
    store.warnOnLoad = 'recovered'

    expect(await new DropRecoveryPolicy().attach(store)).toEqual(['recovered'])
  })
})
