import type { Random } from '../core/random.port.js'

export class SystemRandom implements Random {
  next(): number {
    return Math.random()
  }
}
