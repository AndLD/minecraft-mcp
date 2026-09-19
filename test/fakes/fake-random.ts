import type { Random } from '../../src/core/random.port.js'

/** Returns the given values in order, cycling when exhausted. */
export class FakeRandom implements Random {
  private index = 0

  constructor(private readonly values: readonly number[] = [0.5]) {}

  next(): number {
    const value = this.values[this.index % this.values.length] ?? 0
    this.index += 1
    return value
  }
}
