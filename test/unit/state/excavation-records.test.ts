import { describe, expect, it } from '@jest/globals'
import {
  ExcavationRecords,
  MAX_RECORDS,
  type NewExcavationRecord,
} from '../../../src/state/excavation-records.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { InMemoryStateStore } from '../../fakes/state-fakes.js'

const entry = (patch: Partial<NewExcavationRecord> = {}): NewExcavationRecord => ({
  shape: 'quarry',
  origin: { x: 10, y: 63, z: 20 },
  width: 5,
  length: 4,
  bottom: 58,
  exit: 'stairs',
  stairWidth: 1,
  stairHeight: 4,
  sealCaves: true,
  sealBlock: 'cobblestone',
  ...patch,
})

async function records(store = new InMemoryStateStore()) {
  const list = new ExcavationRecords(new FakeClock(0))
  await list.attach(store)
  return { list, store }
}

describe('ExcavationRecords', () => {
  it('remembers a dig and finds it by its origin', async () => {
    const { list } = await records()

    const saved = list.record(entry())

    expect(saved).toMatchObject({ id: 'dig-1', shape: 'quarry' })
    expect(list.at({ x: 10, y: 63, z: 20 })).toEqual(saved)
    expect(list.at({ x: 11, y: 63, z: 20 })).toBeUndefined()
  })

  it('replaces the record of the same hole when it is dug deeper, keeping its id', async () => {
    const { list } = await records()
    list.record(entry())

    const again = list.record(entry({ bottom: 50 }))

    expect(again?.id).toBe('dig-1')
    expect(list.all()).toHaveLength(1)
    expect(list.all()[0]?.bottom).toBe(50)
  })

  it('finds the digs around a position, the one it stands in first', async () => {
    const { list } = await records()
    list.record(entry())
    list.record(entry({ origin: { x: 60, y: 63, z: 20 } }))

    expect(list.near({ x: 12.5, y: 64, z: 21.5 }).map((r) => r.origin.x)).toEqual([10])
    expect(list.near({ x: 59.5, y: 64, z: 21 }).map((r) => r.origin.x)).toEqual([60])
    expect(list.near({ x: 200, y: 64, z: 200 })).toEqual([])
  })

  it('counts the ring around a footprint as near it', async () => {
    const { list } = await records()
    list.record(entry())

    expect(list.near({ x: 5, y: 64, z: 20 })).toHaveLength(1)
    expect(list.near({ x: -5, y: 64, z: 20 })).toHaveLength(0)
  })

  it('is saved with the world profile and read back', async () => {
    const first = await records()
    first.list.record(entry())

    const second = await records(first.store)

    expect(second.list.all()).toHaveLength(1)
    expect(second.list.record(entry({ origin: { x: 1, y: 63, z: 1 } }))?.id).toBe('dig-2')
  })

  it('keeps nothing while no world is active', async () => {
    const list = new ExcavationRecords(new FakeClock(0))

    expect(list.record(entry())).toBeUndefined()
    const { list: attached } = await records()
    attached.detach()
    expect(attached.all()).toEqual([])
  })

  it('keeps only the most recent digs', async () => {
    const { list } = await records()
    for (let i = 0; i < MAX_RECORDS + 5; i += 1)
      list.record(entry({ origin: { x: i, y: 63, z: 0 } }))

    expect(list.all()).toHaveLength(MAX_RECORDS)
    expect(list.at({ x: 0, y: 63, z: 0 })).toBeUndefined()
  })
})
