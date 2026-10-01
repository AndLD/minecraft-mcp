import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { SystemScheduler } from '../../../src/infra/system-scheduler.js'

describe('SystemScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('runs the callback once after the delay', () => {
    const callback = jest.fn()
    new SystemScheduler().after(1000, callback)

    jest.advanceTimersByTime(999)
    expect(callback).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)
    expect(callback).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(5000)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('does not run a cancelled callback', () => {
    const callback = jest.fn()
    const cancel = new SystemScheduler().after(1000, callback)

    cancel()
    jest.advanceTimersByTime(2000)

    expect(callback).not.toHaveBeenCalled()
  })
})
