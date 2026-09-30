import { describe, expect, it } from '@jest/globals'
import { SmeltJobs, type SmeltJob } from '../../../src/state/smelt-jobs.js'
import { InMemoryStateStore } from '../../fakes/state-fakes.js'

const job = (over: Partial<SmeltJob> = {}): SmeltJob => ({
  x: 1,
  y: 64,
  z: 2,
  item: 'raw_iron',
  produced: 'iron_ingot',
  count: 8,
  loaded: 8,
  collected: 0,
  fuel: 'coal',
  startedAt: 100,
  ...over,
})

describe('SmeltJobs', () => {
  it('records, finds by item, updates, and removes a job', async () => {
    const jobs = new SmeltJobs()
    await jobs.attach(new InMemoryStateStore())

    jobs.put(job())
    jobs.put(job({ x: 5, item: 'beef', produced: 'cooked_beef' }))
    jobs.update({ x: 1, y: 64, z: 2 }, { collected: 3 })

    expect(jobs.forItem('raw_iron')).toMatchObject({ collected: 3 })
    expect(jobs.forItem('sand')).toBeUndefined()
    expect(jobs.all()).toHaveLength(2)

    jobs.remove({ x: 1, y: 64, z: 2 })
    expect(jobs.all().map((entry) => entry.item)).toEqual(['beef'])
  })

  it('replaces a job that is in the same furnace', () => {
    const jobs = new SmeltJobs()

    jobs.put(job())
    jobs.put(job({ item: 'sand', produced: 'glass' }))

    expect(jobs.all()).toMatchObject([{ item: 'sand' }])
  })

  it('works in memory without a world, and forgets on detach', () => {
    const jobs = new SmeltJobs()

    jobs.put(job())
    expect(jobs.all()).toHaveLength(1)

    jobs.detach()
    expect(jobs.all()).toEqual([])
  })

  it('saves to the world and comes back after a reload', async () => {
    const store = new InMemoryStateStore()
    const first = new SmeltJobs()
    await first.attach(store)
    first.put(job())
    first.update({ x: 1, y: 64, z: 2 }, { collected: 2 })

    const second = new SmeltJobs()
    await second.attach(store)

    expect(second.all()).toMatchObject([{ item: 'raw_iron', collected: 2 }])
  })

  it('passes on a warning from loading', async () => {
    const store = new InMemoryStateStore()
    store.warnOnLoad = 'recovered'

    expect(await new SmeltJobs().attach(store)).toEqual(['recovered'])
  })
})
