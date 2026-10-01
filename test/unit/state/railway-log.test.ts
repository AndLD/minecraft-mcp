import { describe, expect, it } from '@jest/globals'
import { MAX_RAILWAYS, RailwayLog, type NewRailway } from '../../../src/state/railway-log.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { InMemoryStateStore } from '../../fakes/state-fakes.js'

const line = (over: Partial<NewRailway> = {}): NewRailway => ({
  label: 'mine line',
  start: { x: 0, y: 64, z: 0 },
  end: { x: 20, y: 64, z: 0 },
  layout: 'surface',
  variant: 'economy',
  rails: 21,
  ...over,
})

async function setup(store = new InMemoryStateStore()) {
  const log = new RailwayLog(new FakeClock(Date.UTC(2026, 8, 24, 12)))
  await log.attach(store)
  return { log, store }
}

describe('RailwayLog', () => {
  it('remembers a line with an id, and the latest is the last one added', async () => {
    const { log } = await setup()

    const first = log.add(line())
    const second = log.add(line({ label: undefined, layout: 'underground' }))

    expect(first).toMatchObject({ ok: true, value: { id: 'railway-1', label: 'mine line', builtAt: '2026-09-24T12:00:00.000Z' } })
    expect(second).toMatchObject({ ok: true, value: { id: 'railway-2', label: null, layout: 'underground' } })
    expect(log.latest()?.id).toBe('railway-2')
    expect(log.all()).toHaveLength(2)
  })

  it('finds a line by id or label, ignoring case', async () => {
    const { log } = await setup()
    log.add(line())

    expect(log.resolve('railway-1')?.label).toBe('mine line')
    expect(log.resolve(' MINE line ')?.id).toBe('railway-1')
    expect(log.resolve('nothing')).toBeUndefined()
  })

  it('trims a label, and treats an empty one as none', async () => {
    const { log } = await setup()

    expect(log.add(line({ label: '  home  ' }))).toMatchObject({ value: { label: 'home' } })
    expect(log.add(line({ label: '   ' }))).toMatchObject({ value: { label: null } })
  })

  it('keeps only the most recent lines', async () => {
    const { log } = await setup()
    for (let i = 0; i < MAX_RAILWAYS + 3; i += 1) log.add(line({ label: `line ${String(i)}` }))

    expect(log.all()).toHaveLength(MAX_RAILWAYS)
    expect(log.all()[0]?.label).toBe('line 3')
  })

  it('saves what it adds and loads it again', async () => {
    const { log, store } = await setup()
    log.add(line())

    const { log: reloaded } = await setup(store)

    expect(reloaded.latest()).toMatchObject({ id: 'railway-1', rails: 21 })
    expect(reloaded.add(line())).toMatchObject({ value: { id: 'railway-2' } })
  })

  it('does nothing without a world, and passes on a load warning', async () => {
    const { log } = await setup()
    log.add(line())
    log.detach()

    expect(log.all()).toEqual([])
    expect(log.latest()).toBeUndefined()
    expect(log.add(line()).ok).toBe(false)
    const store = new InMemoryStateStore()
    store.warnOnLoad = 'recovered'
    expect(await new RailwayLog(new FakeClock(0)).attach(store)).toEqual(['recovered'])
  })
})
