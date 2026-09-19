import { describe, expect, it } from '@jest/globals'
import { SEED_A, SEED_B, buildStateStack, InMemoryStateStore } from '../../fakes/state-fakes.js'

describe('WorldStateManager', () => {
  it('activates the state of a new world: components attach to that profile’s store', async () => {
    const stack = buildStateStack()

    const opened = await stack.worldState.open(SEED_A)

    expect(opened.profile).toBe('survival')
    expect(stack.worldState.activeProfile).toBe('survival')
    expect(opened.resolution).toEqual({ kind: 'created', profile: 'survival', named: false })
    expect(stack.notes.remember('hello').ok).toBe(true)
    expect(stack.profileStores.get('survival')?.data('notes')).toMatchObject({
      notes: [{ text: 'hello' }],
    })
  })

  it('reopens a known world with its saved state and the time of the last visit', async () => {
    const stack = buildStateStack()
    await stack.worldState.open(SEED_A)
    stack.notes.remember('remember me', ['plan'])
    await stack.worldState.close()
    stack.clock.advance(90 * 60_000)

    const again = await stack.worldState.open(SEED_A)

    expect(again.resolution).toEqual({ kind: 'matched', profile: 'survival' })
    expect(again.previousSessionAt).toBe('2026-09-19T12:00:00.000Z')
    expect(stack.notes.recall().ok && stack.notes.latest(5).map((n) => n.text)).toEqual([
      'remember me',
    ])
  })

  it('keeps worlds apart: another world does not see the first one’s data', async () => {
    const stack = buildStateStack()
    await stack.worldState.open(SEED_A)
    stack.notes.remember('only in survival')
    stack.standing.set('rule', 'survival rule')

    const other = await stack.worldState.open(SEED_B)

    expect(other.profile).toBe('creative')
    expect(stack.notes.latest(10)).toEqual([])
    expect(stack.standing.all()).toEqual({})
  })

  it('flushes and detaches the components when closing', async () => {
    const stack = buildStateStack()
    await stack.worldState.open(SEED_A)
    const store = stack.profileStores.get('survival') as InMemoryStateStore
    const before = store.flushCount

    await stack.worldState.close()

    expect(store.flushCount).toBe(before + 1)
    expect(stack.worldState.activeProfile).toBeUndefined()
    expect(stack.notes.remember('too late').ok).toBe(false)
  })

  it('makes every concurrent close wait for the same flush (a shutdown must not outrun a disconnect)', async () => {
    const stack = buildStateStack()
    await stack.worldState.open(SEED_A)
    const store = stack.profileStores.get('survival') as InMemoryStateStore
    let finishFlush: () => void = () => undefined
    store.flush = () =>
      new Promise<void>((resolve) => {
        finishFlush = resolve
      })
    const order: string[] = []

    const first = stack.worldState.close().then(() => order.push('first'))
    const second = stack.worldState.close().then(() => order.push('second'))
    await Promise.resolve()
    expect(order).toEqual([]) // neither has finished while the flush is in flight
    finishFlush()
    await Promise.all([first, second])

    expect(order.sort()).toEqual(['first', 'second'])
    expect(stack.worldState.activeProfile).toBeUndefined()
  })

  it('can be opened again after a close finished', async () => {
    const stack = buildStateStack()
    await stack.worldState.open(SEED_A)
    await stack.worldState.close()

    await stack.worldState.open(SEED_A)
    await stack.worldState.close()
    await stack.worldState.close()

    expect(stack.worldState.activeProfile).toBeUndefined()
  })

  it('closing when nothing is open is harmless', async () => {
    await expect(buildStateStack().worldState.close()).resolves.toBeUndefined()
  })

  it('closes the previous world when another is opened', async () => {
    const stack = buildStateStack()
    await stack.worldState.open(SEED_A)
    const first = stack.profileStores.get('survival') as InMemoryStateStore

    await stack.worldState.open(SEED_B)

    expect(first.flushCount).toBeGreaterThan(0)
    expect(stack.worldState.activeProfile).toBe('creative')
  })

  it('activates nothing when the world cannot be identified, and says so', async () => {
    const stack = buildStateStack()

    const opened = await stack.worldState.open({ seed: null, worldName: null, spawn: null })

    expect(opened.profile).toBeUndefined()
    expect(opened.resolution.kind).toBe('needs_name')
    expect(stack.worldState.activeProfile).toBeUndefined()
    expect(stack.notes.remember('nowhere to put it').ok).toBe(false)
  })

  it('binds a name to the connected world and activates it', async () => {
    const stack = buildStateStack()
    await stack.worldState.open({ seed: null, worldName: null, spawn: null })

    const bound = await stack.worldState.bind('My World', {
      seed: null,
      worldName: null,
      spawn: { x: 1, y: 70, z: 1 },
    })

    expect(bound.profile).toBe('my-world')
    expect(stack.worldState.activeProfile).toBe('my-world')
  })

  it('collects warnings from the registry and the components', async () => {
    const stack = buildStateStack()
    const broken = new InMemoryStateStore()
    broken.warnOnLoad = 'notes.json was corrupt'
    stack.profileStores.set('survival', broken)

    const opened = await stack.worldState.open(SEED_A)

    expect(opened.warnings.filter((w) => w === 'notes.json was corrupt').length).toBeGreaterThan(0)
  })

  it('remembers the last open result even after closing, for the briefing', async () => {
    const stack = buildStateStack()
    expect(stack.worldState.lastOpen).toBeUndefined()

    const opened = await stack.worldState.open(SEED_A)
    await stack.worldState.close()

    expect(stack.worldState.lastOpen).toBe(opened)
  })

  it('lists the worlds it knows', async () => {
    const stack = buildStateStack()
    await stack.worldState.open(SEED_A)

    expect((await stack.worldState.listWorlds()).map((w) => w.name)).toEqual(['survival'])
  })
})
