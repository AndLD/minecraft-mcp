import { describe, expect, it } from '@jest/globals'
import type { WorldFingerprint } from '../../../src/core/world-identifier.port.js'
import { WorldRegistry } from '../../../src/state/world-registry.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { InMemoryStateStore, SEED_A, SEED_B } from '../../fakes/state-fakes.js'

function setup(store = new InMemoryStateStore()) {
  const clock = new FakeClock(Date.UTC(2026, 8, 19, 12, 0, 0))
  return { clock, store, registry: new WorldRegistry({ store, clock }) }
}

const NO_SIGNALS: WorldFingerprint = { seed: null, worldName: null, spawn: { x: 1, y: 70, z: 1 } }

describe('WorldRegistry', () => {
  describe('recognizing worlds', () => {
    it('creates a profile named after the world for one it has not seen', async () => {
      const { registry, store } = setup()

      const resolved = await registry.resolve(SEED_A)

      expect(resolved.resolution).toEqual({ kind: 'created', profile: 'survival', named: false })
      expect(resolved.previousSessionAt).toBeNull()
      expect(store.data('worlds')).toMatchObject({
        profiles: [{ name: 'survival', fingerprint: SEED_A }],
      })
    })

    it('names a world without a name after its seed', async () => {
      const { registry } = setup()

      const resolved = await registry.resolve({
        seed: 'ABCDEF123456',
        worldName: null,
        spawn: null,
      })

      expect(resolved.resolution).toMatchObject({ kind: 'created', profile: 'world-abcdef' })
    })

    it('recognizes the same world again and reports when it was last joined', async () => {
      const { registry, clock } = setup()
      await registry.resolve(SEED_A)
      clock.advance(3_600_000)

      const again = await registry.resolve(SEED_A)

      expect(again.resolution).toEqual({ kind: 'matched', profile: 'survival' })
      expect(again.previousSessionAt).toBe('2026-09-19T12:00:00.000Z')
    })

    it('keeps worlds with different seeds apart', async () => {
      const { registry } = setup()
      await registry.resolve(SEED_A)

      const other = await registry.resolve(SEED_B)

      expect(other.resolution).toEqual({ kind: 'created', profile: 'creative', named: false })
      expect((await registry.list()).map((w) => w.name)).toEqual(['survival', 'creative'])
    })

    it('does not mistake a different seed for the same world, even with the same name', async () => {
      const { registry } = setup()
      await registry.resolve(SEED_A)

      const clone = await registry.resolve({ ...SEED_A, seed: 'cccc3333' })

      expect(clone.resolution).toEqual({ kind: 'created', profile: 'survival-2', named: false })
    })

    it('still recognizes a renamed world by its seed, and remembers the new name', async () => {
      const { registry } = setup()
      await registry.resolve(SEED_A)

      const renamed = await registry.resolve({ ...SEED_A, worldName: 'Survival Reloaded' })

      expect(renamed.resolution).toEqual({ kind: 'matched', profile: 'survival' })
      expect((await registry.list())[0]?.fingerprint.worldName).toBe('Survival Reloaded')
    })

    it('fills in signals it did not have before (a seed learned later)', async () => {
      const { registry } = setup()
      await registry.resolve({ seed: null, worldName: 'Survival', spawn: { x: 48, y: 81, z: 32 } })

      const later = await registry.resolve(SEED_A)

      expect(later.resolution).toEqual({ kind: 'matched', profile: 'survival' })
      expect((await registry.list())[0]?.fingerprint.seed).toBe(SEED_A.seed)
    })

    it('asks for a name when the world gives no seed and no name', async () => {
      const { registry } = setup()

      const resolved = await registry.resolve(NO_SIGNALS)

      expect(resolved.resolution.kind).toBe('needs_name')
      expect(await registry.list()).toEqual([])
    })

    it('reports ambiguity when several profiles fit equally well', async () => {
      const { registry } = setup()
      const twin = { seed: null, worldName: 'Home', spawn: { x: 5, y: 70, z: 5 } }
      await registry.bind('first', twin)
      await registry.bind('second', twin)

      const resolved = await registry.resolve(twin)

      expect(resolved.resolution).toEqual({ kind: 'ambiguous', candidates: ['first', 'second'] })
    })

    it('prefers the best fit when one profile fits better', async () => {
      const { registry } = setup()
      await registry.bind('weak', { seed: null, worldName: 'Home', spawn: { x: 5, y: 70, z: 5 } })
      await registry.bind('strong', {
        seed: 'abc',
        worldName: 'Home',
        spawn: { x: 5, y: 70, z: 5 },
      })

      const resolved = await registry.resolve({
        seed: 'abc',
        worldName: 'Home',
        spawn: { x: 5, y: 70, z: 5 },
      })

      expect(resolved.resolution).toEqual({ kind: 'matched', profile: 'strong' })
    })

    it('makes profile names unique', async () => {
      const { registry } = setup()
      await registry.resolve(SEED_A)
      await registry.resolve({ ...SEED_A, seed: 'dddd' })

      const third = await registry.resolve({ ...SEED_A, seed: 'eeee' })

      expect(third.resolution).toMatchObject({ profile: 'survival-3' })
    })
  })

  describe('naming a world (bind)', () => {
    it('creates a profile with the given name', async () => {
      const { registry } = setup()

      const bound = await registry.bind('My Survival World', NO_SIGNALS)

      expect(bound.resolution).toEqual({
        kind: 'created',
        profile: 'my-survival-world',
        named: true,
      })
    })

    it('uses an existing profile and remembers the fingerprint it now sees', async () => {
      const { registry } = setup()
      await registry.bind('home', { seed: null, worldName: 'Home', spawn: null })

      const bound = await registry.bind('home', SEED_A)

      expect(bound.resolution).toEqual({ kind: 'named', profile: 'home', rebound: false })
      expect((await registry.list())[0]?.fingerprint.seed).toBe(SEED_A.seed)
    })

    it('warns when the world looks different from what the profile remembered, and re-binds it', async () => {
      const { registry } = setup()
      await registry.resolve(SEED_A)

      const bound = await registry.bind('survival', SEED_B)

      expect(bound.resolution).toEqual({ kind: 'named', profile: 'survival', rebound: true })
      expect(bound.warnings[0]).toContain('different seed')
      expect((await registry.list())[0]?.fingerprint.seed).toBe(SEED_B.seed)
    })

    it('rejects a name with nothing usable in it', async () => {
      const { registry } = setup()

      expect((await registry.bind('///', SEED_A)).resolution).toEqual({
        kind: 'invalid_name',
        name: '///',
      })
      expect(await registry.list()).toEqual([])
    })

    it('resolve with an explicit name goes through bind', async () => {
      const { registry } = setup()

      const resolved = await registry.resolve(NO_SIGNALS, 'fallback')

      expect(resolved.resolution).toEqual({ kind: 'created', profile: 'fallback', named: true })
    })
  })

  describe('persistence', () => {
    it('saves the list of worlds and reloads it in a new registry', async () => {
      const { registry, store, clock } = setup()
      await registry.resolve(SEED_A)
      const reloaded = new WorldRegistry({ store, clock })

      expect((await reloaded.list()).map((w) => w.name)).toEqual(['survival'])
      expect((await reloaded.resolve(SEED_A)).resolution.kind).toBe('matched')
      expect(store.flushCount).toBeGreaterThan(0)
    })

    it('reports a problem with the saved list once', async () => {
      const store = new InMemoryStateStore()
      store.warnOnLoad = 'worlds.json could not be read'
      const { registry } = setup(store)

      const first = await registry.resolve(SEED_A)
      const second = await registry.resolve(SEED_A)

      expect(first.warnings).toEqual(['worlds.json could not be read'])
      expect(second.warnings).toEqual([])
    })
  })
})
