import { describe, expect, it } from '@jest/globals'
import {
  STATIONS,
  STATION_NAMES,
  stationSmelts,
  stationsFor,
} from '../../../../src/skills/smelting/stations.js'
import { SMELTABLE_ITEMS } from '../../../../src/skills/smelting/smelting-table.js'

describe('stations', () => {
  it('a blast furnace and a smoker take half the time of a furnace and stretch the fuel twice as far', () => {
    expect(STATIONS.furnace).toMatchObject({ msPerItem: 10_000, speed: 1 })
    expect(STATIONS.blast_furnace).toMatchObject({ msPerItem: 5_000, speed: 2 })
    expect(STATIONS.smoker).toMatchObject({ msPerItem: 5_000, speed: 2 })
    expect(STATION_NAMES.map((name) => STATIONS[name].block)).toEqual([...STATION_NAMES])
  })

  it('a furnace smelts everything in the table', () => {
    for (const item of SMELTABLE_ITEMS) expect(stationSmelts('furnace', item)).toBe(true)
    expect(stationSmelts('furnace', 'dirt')).toBe(false)
  })

  it.each([
    'raw_iron',
    'raw_gold',
    'raw_copper',
    'iron_ore',
    'deepslate_gold_ore',
    'ancient_debris',
  ])('a blast furnace smelts %s and a smoker does not', (item) => {
    expect(stationSmelts('blast_furnace', item)).toBe(true)
    expect(stationSmelts('smoker', item)).toBe(false)
  })

  it.each(['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato', 'kelp'])(
    'a smoker cooks %s and a blast furnace does not',
    (item) => {
      expect(stationSmelts('smoker', item)).toBe(true)
      expect(stationSmelts('blast_furnace', item)).toBe(false)
    },
  )

  it.each(['cobblestone', 'sand', 'oak_log', 'clay_ball'])('only a furnace smelts %s', (item) => {
    expect(stationSmelts('blast_furnace', item)).toBe(false)
    expect(stationSmelts('smoker', item)).toBe(false)
    expect(stationSmelts('furnace', item)).toBe(true)
  })

  it('lists the faster stations first, and always ends with the furnace', () => {
    expect(stationsFor('raw_iron')).toEqual(['blast_furnace', 'furnace'])
    expect(stationsFor('beef')).toEqual(['smoker', 'furnace'])
    expect(stationsFor('sand')).toEqual(['furnace'])
    expect(stationsFor('dirt')).toEqual([])
  })
})

describe('campfire', () => {
  it('cooks raw food, but not kelp, ores, or blocks', async () => {
    const { campfireCooks } = await import('../../../../src/skills/smelting/stations.js')
    for (const item of [
      'beef',
      'porkchop',
      'mutton',
      'chicken',
      'rabbit',
      'cod',
      'salmon',
      'potato',
    ])
      expect(campfireCooks(item)).toBe(true)
    for (const item of ['kelp', 'raw_iron', 'sand', 'dirt']) expect(campfireCooks(item)).toBe(false)
  })
})
