import type { Clock } from '../../src/core/clock.port.js'

export class FakeClock implements Clock {
  constructor(private current = 0) {}

  now(): number {
    return this.current
  }

  advance(ms: number): void {
    this.current += ms
  }
}
