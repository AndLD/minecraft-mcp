import { describe, expect, it } from '@jest/globals'
import { FakeClock } from '../fakes/fake-clock.js'
import { FakeLogger } from '../fakes/fake-logger.js'
import { FakeRandom } from '../fakes/fake-random.js'

describe('test fakes', () => {
  it('FakeClock advances manually', () => {
    const clock = new FakeClock(100)
    clock.advance(50)
    expect(clock.now()).toBe(150)
  })

  it('FakeRandom cycles through its values', () => {
    const random = new FakeRandom([0.1, 0.9])
    expect([random.next(), random.next(), random.next()]).toEqual([0.1, 0.9, 0.1])
  })

  it('FakeLogger records entries per level', () => {
    const logger = new FakeLogger()
    logger.debug('d')
    logger.info('i', { a: 1 })
    logger.warn('w')
    logger.error('e')
    expect(logger.entries.map((e) => e.level)).toEqual(['debug', 'info', 'warn', 'error'])
    expect(logger.entries[1]?.context).toEqual({ a: 1 })
  })
})
