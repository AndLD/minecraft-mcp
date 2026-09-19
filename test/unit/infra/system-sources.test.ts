import { describe, expect, it } from '@jest/globals'
import { SystemClock } from '../../../src/infra/system-clock.js'
import { SystemRandom } from '../../../src/infra/system-random.js'

describe('SystemClock', () => {
  it('returns the current time in epoch milliseconds', () => {
    const before = Date.now()
    const now = new SystemClock().now()
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(Date.now())
  })
})

describe('SystemRandom', () => {
  it('returns numbers in [0, 1)', () => {
    const random = new SystemRandom()
    for (let i = 0; i < 100; i += 1) {
      const value = random.next()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})
