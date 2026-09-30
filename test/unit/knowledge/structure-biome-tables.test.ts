import { describe, expect, it } from '@jest/globals'
import type { BiomeReader } from '../../../src/core/biome.port.js'
import {
  STRUCTURE_BIOME_TABLES,
  DEFAULT_BIOME_TABLE_VERSION,
} from '../../../src/knowledge/structure-biomes/index.js'
import type { VersionedBiomeTable } from '../../../src/knowledge/structure-biomes/structure-biome-table.types.js'
import { StructureBiomeTables } from '../../../src/knowledge/structure-biomes/structure-biome-tables.js'
import { FakeLogger } from '../../fakes/fake-logger.js'

const ALL = [
  'plains',
  'sunflower_plains',
  'meadow',
  'desert',
  'savanna',
  'snowy_plains',
  'taiga',
  'forest',
  'ocean',
  'deep_ocean',
  'jungle',
  'sparse_jungle',
  'bamboo_jungle',
]

const reader = (names: readonly string[]): BiomeReader => ({
  biomeAt: () => undefined,
  knownBiomeNames: () => names,
})

function build(
  version: string,
  over: { tables?: readonly VersionedBiomeTable[]; names?: readonly string[] } = {},
) {
  const logger = new FakeLogger()
  const tables = new StructureBiomeTables({
    tables: over.tables ?? STRUCTURE_BIOME_TABLES,
    defaultVersion: DEFAULT_BIOME_TABLE_VERSION,
    version,
    biomes: reader(over.names ?? ALL),
    logger,
  })
  return { tables, logger }
}

describe('StructureBiomeTables', () => {
  it('the default version is 1.21.1 and has rules for the kinds with a biome rule', () => {
    expect(DEFAULT_BIOME_TABLE_VERSION).toBe('1.21.1')
    const { tables, logger } = build('1.21.1')

    expect(tables.ruleFor('desert_temple')?.biomes).toEqual(['desert'])
    expect(tables.ruleFor('village')?.biomes).toContain('plains')
    expect(tables.ruleFor('jungle_temple')?.biomes).toEqual([
      'jungle',
      'sparse_jungle',
      'bamboo_jungle',
    ])
    expect(tables.source).toBe('1.21.1')
    expect(logger.entries.filter((entry) => entry.level === 'info')).toEqual([])
  })

  it('has no rule for a kind that biomes say nothing about', () => {
    const { tables } = build('1.21.1')

    expect(tables.ruleFor('mineshaft')).toBeUndefined()
    expect(tables.ruleFor('stronghold')).toBeUndefined()
    expect(tables.ruleFor('dungeon')).toBeUndefined()
  })

  it('uses the default table for a version without its own, and says so once', () => {
    const { tables, logger } = build('1.20.4')

    expect(tables.ruleFor('desert_temple')?.biomes).toEqual(['desert'])
    expect(tables.ruleFor('village')).toBeDefined()
    expect(tables.source).toBe('1.21.1')
    const notes = logger.entries.filter((entry) => entry.level === 'info')
    expect(notes).toHaveLength(1)
    expect(notes[0]?.message).toContain('1.20.4')
    expect(notes[0]?.message).toContain('1.21.1')
  })

  it('uses the table of the exact version, merged over the default so it can list only what differs', () => {
    const newer: VersionedBiomeTable = {
      version: '1.22',
      rules: { desert_temple: { biomes: ['desert', 'badlands'] } },
    }
    const { tables, logger } = build('1.22', {
      tables: [...STRUCTURE_BIOME_TABLES, newer],
      names: [...ALL, 'badlands'],
    })

    expect(tables.ruleFor('desert_temple')?.biomes).toEqual(['desert', 'badlands'])
    expect(tables.ruleFor('village')?.biomes).toContain('plains') // from the default
    expect(tables.source).toBe('1.22')
    expect(logger.entries.filter((entry) => entry.level === 'info')).toEqual([])
  })

  it('drops a biome the game does not have, with one warning, and keeps the rest', () => {
    const { tables, logger } = build('1.21.1', { names: ['desert', 'plains', 'ocean'] })

    expect(tables.ruleFor('desert_temple')?.neighbours).toEqual(['plains'])
    expect(tables.ruleFor('desert_temple')?.never).toEqual(['ocean'])
    tables.ruleFor('desert_temple')
    const warnings = logger.entries.filter((entry) => entry.level === 'warn')
    expect(warnings.some((entry) => entry.message.includes('"savanna"'))).toBe(true)
    expect(warnings.filter((entry) => entry.message.includes('"savanna"'))).toHaveLength(1)
  })

  it('has no rule when none of its biomes exist in the game', () => {
    const { tables } = build('1.21.1', { names: ['plains'] })

    expect(tables.ruleFor('desert_temple')).toBeUndefined()
  })

  it('checks nothing while the game is not connected (no biome names yet)', () => {
    const { tables, logger } = build('1.21.1', { names: [] })

    expect(tables.ruleFor('desert_temple')?.biomes).toEqual(['desert'])
    expect(logger.entries).toEqual([])
  })

  it('copes with a missing default table', () => {
    const { tables } = build('9.9', { tables: [] })

    expect(tables.ruleFor('village')).toBeUndefined()
  })
})
