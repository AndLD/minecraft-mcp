import { describe, expect, it } from '@jest/globals'
import { matchName, normalizeName } from '../../../../src/skills/discovery/name-match.js'

const biomes = [
  'plains',
  'desert',
  'jungle',
  'sparse_jungle',
  'bamboo_jungle',
  'cherry_grove',
  'forest',
  'birch_forest',
]

describe('normalizeName', () => {
  it('lowercases, drops the namespace, and joins words with underscores', () => {
    expect(normalizeName('  Minecraft:Cherry Grove ')).toBe('cherry_grove')
    expect(normalizeName('polar-bear')).toBe('polar_bear')
  })
})

describe('matchName', () => {
  it('takes an exact name alone, even when others contain it', () => {
    expect(matchName('Forest', biomes)).toEqual({ ok: true, names: ['forest'] })
    expect(matchName('desert', biomes)).toEqual({ ok: true, names: ['desert'] })
    expect(matchName('cherry grove', biomes)).toEqual({ ok: true, names: ['cherry_grove'] })
  })

  it('covers every name that contains a general word', () => {
    expect(matchName('bamboo', biomes)).toEqual({ ok: true, names: ['bamboo_jungle'] })
    expect(matchName('grove', biomes)).toEqual({ ok: true, names: ['cherry_grove'] })
    expect(matchName('birch', biomes)).toEqual({ ok: true, names: ['birch_forest'] })
  })

  it('suggests names for one that does not exist, and none for an empty word', () => {
    expect(matchName('deserts', biomes)).toEqual({ ok: false, suggestions: ['desert'] })
    expect(matchName('junglee', biomes)).toMatchObject({ ok: false })
    expect(matchName('  ', biomes)).toEqual({ ok: false, suggestions: [] })
    expect(matchName('xyzzy', biomes)).toEqual({ ok: false, suggestions: [] })
  })
})
