import { describe, expect, it } from '@jest/globals'
import { toProfileName } from '../../../src/state/profile-name.js'

describe('toProfileName', () => {
  it.each([
    ['AI bot test world', 'ai-bot-test-world'],
    ['Survival1', 'survival1'],
    ['  My  World!! ', 'my-world'],
    ['a_b.c', 'a-b-c'],
    ['Мир 2', '2'],
  ])('turns %j into %j', (text, expected) => {
    expect(toProfileName(text)).toBe(expected)
  })

  it.each(['', '   ', '---', '../../etc', '///'])(
    'cannot make a name from %j (or leaves nothing unsafe)',
    (text) => {
      const name = toProfileName(text)
      if (name !== undefined) expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    },
  )

  it('never returns path characters', () => {
    expect(toProfileName('../../etc/passwd')).toBe('etc-passwd')
    expect(toProfileName('..')).toBeUndefined()
  })

  it('limits the length and does not end with a dash', () => {
    const name = toProfileName(`${'a'.repeat(39)} b`)

    expect(name).toBe('a'.repeat(39))
    expect(toProfileName('x'.repeat(100))).toHaveLength(40)
  })
})
