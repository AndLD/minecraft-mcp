import type { Clock } from '../core/clock.port.js'

export class SystemClock implements Clock {
  now(): number {
    return Date.now()
  }
}
