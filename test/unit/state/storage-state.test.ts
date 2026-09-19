import { describe, expect, it } from '@jest/globals'
import {
  ContainerIndex,
  isContainerBlock,
  MAX_CONTAINERS,
} from '../../../src/state/container-index.js'
import { StoragePolicy } from '../../../src/state/storage-policy.js'
import { MAX_RULES, StorageRules } from '../../../src/state/storage-rules.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { InMemoryStateStore } from '../../fakes/state-fakes.js'

async function index(store = new InMemoryStateStore()) {
  const containers = new ContainerIndex(new FakeClock(Date.UTC(2026, 8, 19, 12)))
  await containers.attach(store)
  return { containers, store }
}

const at = (x: number, y = 64, z = 0) => ({ x, y, z })

describe('isContainerBlock', () => {
  it.each(['chest', 'trapped_chest', 'barrel', 'shulker_box', 'red_shulker_box'])(
    '%s is a container',
    (name) => {
      expect(isContainerBlock(name)).toBe(true)
    },
  )
  it.each(['furnace', 'ender_chest', 'crafting_table', 'stone'])('%s is not', (name) => {
    expect(isContainerBlock(name)).toBe(false)
  })
})

describe('ContainerIndex', () => {
  it('registers a container with a label and remembers it under an id', async () => {
    const { containers } = await index()

    const entry = containers.register(at(4.7, 64.2, -3.1), 'chest', { label: 'home' })

    expect(entry).toMatchObject({
      ok: true,
      value: {
        id: 'container-1',
        label: 'home',
        position: at(4, 64, -4),
        protected: false,
        auto: false,
      },
    })
    expect(containers.resolve('home')?.id).toBe('container-1')
    expect(containers.resolve('HOME')?.id).toBe('container-1')
    expect(containers.resolve('container-1')?.label).toBe('home')
    expect(containers.at(at(4, 64, -4))?.id).toBe('container-1')
  })

  it('registering a known place again updates it instead of adding another', async () => {
    const { containers } = await index()
    containers.register(at(4), 'chest')

    const again = containers.register(at(4), 'chest', { label: 'wood', protected: true })

    expect(again).toMatchObject({
      ok: true,
      value: { id: 'container-1', label: 'wood', protected: true },
    })
    expect(containers.all()).toHaveLength(1)
  })

  it('sees the other half of a double chest as the same container', async () => {
    const { containers } = await index()
    containers.register(at(4), 'chest', { label: 'big' })

    const half = containers.register(at(5), 'chest')
    const barrel = containers.register(at(6), 'barrel')

    expect(half).toMatchObject({ ok: true, value: { id: 'container-1' } })
    expect(barrel).toMatchObject({ ok: true, value: { id: 'container-2' } })
    expect(containers.all()).toHaveLength(2)
  })

  it('keeps labels unique and rejects things that are not containers', async () => {
    const { containers } = await index()
    containers.register(at(4), 'chest', { label: 'home' })

    expect(containers.register(at(20), 'chest', { label: 'Home' })).toMatchObject({ ok: false })
    expect(containers.register(at(30), 'furnace')).toEqual({
      ok: false,
      error: 'furnace is not a container.',
    })
    const other = containers.register(at(20), 'chest', { label: 'wood' })
    expect(other.ok && containers.amend(other.value.id, { label: 'home' }).ok).toBe(false)
  })

  it('changes labels and the protected flag, and an empty label removes the label', async () => {
    const { containers } = await index()
    containers.register(at(4), 'chest', { label: 'home', auto: true })

    const renamed = containers.amend('container-1', { label: 'base' })
    const cleared = containers.amend('container-1', { label: '', protected: true })

    expect(renamed).toMatchObject({ ok: true, value: { label: 'base', auto: false } })
    expect(cleared).toMatchObject({ ok: true, value: { label: null, protected: true } })
    expect(containers.amend('container-9', {}).ok).toBe(false)
  })

  it('records what was seen inside, adding up stacks, with the time', async () => {
    const { containers } = await index()
    containers.register(at(4), 'chest')

    containers.recordContents(
      'container-1',
      [
        { name: 'dirt', count: 64 },
        { name: 'dirt', count: 10 },
        { name: 'stick', count: 3 },
      ],
      { totalSlots: 27, emptySlots: 24 },
    )

    expect(containers.get('container-1')).toMatchObject({
      contents: [
        { name: 'dirt', count: 74 },
        { name: 'stick', count: 3 },
      ],
      totalSlots: 27,
      emptySlots: 24,
      seenAt: '2026-09-19T12:00:00.000Z',
    })
    containers.recordContents('container-9', [], { totalSlots: 27, emptySlots: 27 }) // unknown: ignored
  })

  it('removes and lists containers', async () => {
    const { containers } = await index()
    containers.register(at(4), 'chest')
    containers.register(at(20), 'barrel')

    expect(containers.remove('container-1')).toMatchObject({ ok: true })
    expect(containers.remove('container-1').ok).toBe(false)
    const list = containers.list()
    expect(list.ok && list.value.map((c) => c.id)).toEqual(['container-2'])
  })

  it('keeps a bounded number', async () => {
    const { containers } = await index()
    for (let i = 0; i < MAX_CONTAINERS; i += 1) containers.register(at(i * 3, 64, 0), 'barrel')

    expect(containers.register(at(9999), 'barrel').ok).toBe(false)
  })

  it('saves what changes and loads it again', async () => {
    const { containers, store } = await index()
    containers.register(at(4), 'chest', { label: 'home', protected: true })

    const { containers: reloaded } = await index(store)

    expect(reloaded.resolve('home')).toMatchObject({ id: 'container-1', protected: true })
    expect(reloaded.register(at(50), 'barrel')).toMatchObject({
      ok: true,
      value: { id: 'container-2' },
    })
  })

  it('does nothing without a world, and passes on load warnings', async () => {
    const { containers } = await index()
    containers.register(at(4), 'chest')
    containers.detach()

    expect(containers.all()).toEqual([])
    expect(containers.register(at(4), 'chest').ok).toBe(false)
    expect(containers.amend('container-1', {}).ok).toBe(false)
    expect(containers.remove('container-1').ok).toBe(false)
    expect(containers.list().ok).toBe(false)
    const store = new InMemoryStateStore()
    store.warnOnLoad = 'recovered'
    expect(await new ContainerIndex(new FakeClock()).attach(store)).toEqual(['recovered'])
  })
})

describe('StorageRules', () => {
  async function rules(store = new InMemoryStateStore()) {
    const r = new StorageRules()
    await r.attach(store)
    return { rules: r, store }
  }

  it('adds rules, cleaning the item list, and orders them by priority', async () => {
    const { rules: r } = await rules()

    r.add('container-1', [' cobblestone ', 'stone', 'stone', ''], 0)
    r.add('container-2', ['*'], -10)
    r.add('container-3', ['ores'], 5)

    expect(r.ordered().map((rule) => rule.containerId)).toEqual([
      'container-3',
      'container-1',
      'container-2',
    ])
    expect(r.ordered()[1]?.specs).toEqual(['cobblestone', 'stone'])
  })

  it('refuses a rule with nothing in it and too many rules', async () => {
    const { rules: r } = await rules()

    expect(r.add('container-1', [' ']).ok).toBe(false)
    for (let i = 0; i < MAX_RULES; i += 1) r.add('container-1', ['dirt'])
    expect(r.add('container-1', ['dirt']).ok).toBe(false)
  })

  it('removes a rule, and every rule of a container that is gone', async () => {
    const { rules: r } = await rules()
    r.add('container-1', ['dirt'])
    r.add('container-1', ['sand'])
    r.add('container-2', ['gravel'])

    expect(r.remove('rule-1')).toMatchObject({ ok: true })
    expect(r.remove('rule-1').ok).toBe(false)
    r.removeForContainer('container-1')
    r.removeForContainer('container-7') // nothing to do

    const list = r.list()
    expect(list.ok && list.value.map((rule) => rule.id)).toEqual(['rule-3'])
  })

  it('is saved, reloaded, and inactive without a world', async () => {
    const { rules: r, store } = await rules()
    r.add('container-1', ['ores'], 3)

    const { rules: reloaded } = await rules(store)
    expect(reloaded.ordered()).toEqual([
      { id: 'rule-1', containerId: 'container-1', specs: ['ores'], priority: 3 },
    ])
    expect(reloaded.add('container-2', ['dirt'])).toMatchObject({
      ok: true,
      value: { id: 'rule-2' },
    })

    reloaded.detach()
    expect(reloaded.ordered()).toEqual([])
    expect(reloaded.add('c', ['dirt']).ok).toBe(false)
    expect(reloaded.remove('rule-1').ok).toBe(false)
    expect(reloaded.list().ok).toBe(false)
    store.warnOnLoad = 'recovered'
    expect(await new StorageRules().attach(store)).toEqual(['recovered'])
  })
})

describe('StoragePolicy', () => {
  it('defaults to asking, with limits, and saves changes', async () => {
    const store = new InMemoryStateStore()
    const policy = new StoragePolicy()
    await policy.attach(store)

    expect(policy.get()).toEqual({ kind: 'ask', maxTrips: 20, maxDistance: 64 })
    expect(policy.set({ kind: 'offload_and_return', maxTrips: 5 })).toMatchObject({ ok: true })

    const reloaded = new StoragePolicy()
    await reloaded.attach(store)
    expect(reloaded.get()).toEqual({ kind: 'offload_and_return', maxTrips: 5, maxDistance: 64 })
  })

  it('cannot be set without a world, and falls back to the default', async () => {
    const policy = new StoragePolicy()
    expect(policy.set({ kind: 'stop' }).ok).toBe(false)
    await policy.attach(new InMemoryStateStore())
    policy.set({ kind: 'stop' })

    policy.detach()

    expect(policy.get().kind).toBe('ask')
    const store = new InMemoryStateStore()
    store.warnOnLoad = 'recovered'
    expect(await new StoragePolicy().attach(store)).toEqual(['recovered'])
  })
})
