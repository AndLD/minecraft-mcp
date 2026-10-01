import { describe, expect, it } from '@jest/globals'
import { FakeClock } from '../fakes/fake-clock.js'
import { FakeLogger } from '../fakes/fake-logger.js'
import { FakeRandom } from '../fakes/fake-random.js'
import { FakeScheduler } from '../fakes/fake-scheduler.js'

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

  describe('FakeScheduler', () => {
    it('runs due callbacks in order while moving the clock', () => {
      const clock = new FakeClock(0)
      const scheduler = new FakeScheduler(clock)
      const seen: string[] = []
      scheduler.after(200, () => seen.push(`b@${String(clock.now())}`))
      scheduler.after(100, () => seen.push(`a@${String(clock.now())}`))
      scheduler.after(900, () => seen.push('late'))

      scheduler.advance(500)

      expect(seen).toEqual(['a@100', 'b@200'])
      expect(clock.now()).toBe(500)
      expect(scheduler.pendingCount).toBe(1)
    })

    it('does not run cancelled callbacks', () => {
      const scheduler = new FakeScheduler(new FakeClock(0))
      const seen: string[] = []
      const cancel = scheduler.after(100, () => seen.push('x'))
      cancel()
      scheduler.advance(1000)
      expect(seen).toEqual([])
    })
  })
})
