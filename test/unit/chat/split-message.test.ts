import { describe, expect, it } from '@jest/globals'
import { MAX_CHAT_LENGTH, splitChatMessage } from '../../../src/chat/split-message.js'

describe('splitChatMessage', () => {
  it('keeps a short message as one line', () => {
    expect(splitChatMessage('hello there')).toEqual(['hello there'])
  })

  it('keeps a message of exactly the maximum length', () => {
    const text = 'a'.repeat(MAX_CHAT_LENGTH)
    expect(splitChatMessage(text)).toEqual([text])
  })

  it('breaks long text at spaces', () => {
    const lines = splitChatMessage('one two three four', 10)
    expect(lines).toEqual(['one two', 'three four'])
  })

  it('breaks a long word without spaces at the limit', () => {
    expect(splitChatMessage('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('never produces a line above the limit', () => {
    const text = 'lorem ipsum dolor sit amet '.repeat(40)
    for (const line of splitChatMessage(text))
      expect(line.length).toBeLessThanOrEqual(MAX_CHAT_LENGTH)
  })

  it('treats newlines as line breaks and drops empty lines', () => {
    expect(splitChatMessage('first\n\n  second  \r\nthird')).toEqual(['first', 'second', 'third'])
  })

  it('returns nothing for empty or blank text', () => {
    expect(splitChatMessage('')).toEqual([])
    expect(splitChatMessage('   \n  ')).toEqual([])
  })
})
