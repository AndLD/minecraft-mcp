import { describe, expect, it } from '@jest/globals'
import { formatReason } from '../../../src/bot/format-reason.js'

describe('formatReason', () => {
  it('returns strings unchanged', () => {
    expect(formatReason('Server closed')).toBe('Server closed')
  })

  it('uses the message of an Error', () => {
    expect(formatReason(new Error('boom'))).toBe('boom')
  })

  it('serializes chat components as JSON', () => {
    expect(formatReason({ text: 'You are banned' })).toBe('{"text":"You are banned"}')
  })

  it('falls back to String() for values that cannot be serialized', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(formatReason(circular)).toBe('[object Object]')
  })
})
