import { describe, expect, it } from '@jest/globals'
import { z } from 'zod'
import { defineDocument } from '../../../src/state/define-document.js'

const v2 = defineDocument({
  key: 'things',
  version: 2,
  schema: z.object({ names: z.array(z.string()) }),
  initial: () => ({ names: [] as string[] }),
  // version 1 stored a single "name"
  migrations: { 1: (data) => ({ names: [(data as { name: string }).name] }) },
})

describe('defineDocument', () => {
  it('exposes its key, version, and defaults', () => {
    expect(v2.key).toBe('things')
    expect(v2.version).toBe(2)
    expect(v2.initial()).toEqual({ names: [] })
  })

  it('accepts current data', () => {
    expect(v2.parse({ names: ['a'] }, 2)).toEqual({ names: ['a'] })
  })

  it('migrates older versions', () => {
    expect(v2.parse({ name: 'old' }, 1)).toEqual({ names: ['old'] })
  })

  it('rejects data that does not match the schema', () => {
    expect(v2.parse({ names: 'nope' }, 2)).toBeUndefined()
  })

  it('rejects a version from the future', () => {
    expect(v2.parse({ names: [] }, 3)).toBeUndefined()
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects the invalid version %s', (version) => {
    expect(v2.parse({ names: [] }, version)).toBeUndefined()
  })

  it('rejects old data when a migration step is missing', () => {
    const noMigration = defineDocument({
      key: 'x',
      version: 2,
      schema: z.object({}),
      initial: () => ({}),
    })

    expect(noMigration.parse({}, 1)).toBeUndefined()
  })

  it('rejects data when a migration throws', () => {
    expect(v2.parse(null, 1)).toBeUndefined()
  })
})
