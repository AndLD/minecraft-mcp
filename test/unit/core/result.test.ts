import { describe, expect, it } from '@jest/globals'
import { err, ok } from '../../../src/core/result.js'

describe('Result helpers', () => {
  it('wraps a value as a success', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 })
  })

  it('wraps an error as a failure', () => {
    expect(err('boom')).toEqual({ ok: false, error: 'boom' })
  })
})
