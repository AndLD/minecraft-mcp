import { describe, expect, it } from '@jest/globals'
import {
  BLOCK_ALIAS_NAMES,
  expandBlockNames,
} from '../../../../src/skills/gathering/block-aliases.js'

const known = [
  'oak_log',
  'birch_log',
  'stripped_oak_log',
  'oak_planks',
  'iron_ore',
  'deepslate_iron_ore',
  'oak_leaves',
  'stone',
]

describe('expandBlockNames', () => {
  it('passes plain names through', () => {
    expect(expandBlockNames(['stone', 'oak_planks'], known)).toEqual(['stone', 'oak_planks'])
  })

  it('expands logs to every log except stripped ones', () => {
    expect(expandBlockNames(['logs'], known)).toEqual(['oak_log', 'birch_log'])
  })

  it('expands ores and leaves', () => {
    expect(expandBlockNames(['ores'], known)).toEqual(['iron_ore', 'deepslate_iron_ore'])
    expect(expandBlockNames(['leaves'], known)).toEqual(['oak_leaves'])
  })

  it('mixes groups and names without duplicates', () => {
    expect(expandBlockNames(['oak_log', 'logs', 'stone'], known)).toEqual([
      'oak_log',
      'birch_log',
      'stone',
    ])
  })

  it('lists the group names it knows', () => {
    expect(BLOCK_ALIAS_NAMES).toEqual(['logs', 'ores', 'leaves'])
  })
})
