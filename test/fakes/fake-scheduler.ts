import type { Scheduler } from '../../src/core/scheduler.port.js'
import type { FakeClock } from './fake-clock.js'

interface Timer {
  readonly at: number
  readonly callback: () => void
}

/** Runs callbacks when the fake clock is advanced. No real timers are involved. */
export class FakeScheduler implements Scheduler {
  private timers = new Set<Timer>()

  constructor(private readonly clock: FakeClock) {}

  get pendingCount(): number {
    return this.timers.size
  }

  after(delayMs: number, callback: () => void): () => void {
    const timer: Timer = { at: this.clock.now() + delayMs, callback }
    this.timers.add(timer)
    return () => {
      this.timers.delete(timer)
    }
  }

  /** Moves time forward, running due callbacks in order. */
  advance(ms: number): void {
    const target = this.clock.now() + ms
    for (;;) {
      const next = [...this.timers].filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
      if (next === undefined) break
      this.timers.delete(next)
      this.clock.advance(Math.max(0, next.at - this.clock.now()))
      next.callback()
    }
    this.clock.advance(target - this.clock.now())
  }
}
