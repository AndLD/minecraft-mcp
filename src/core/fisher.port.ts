import type { Result } from './result.js'

export interface FishFailure {
  readonly reason: 'no_rod' | 'not_connected' | 'aborted' | 'failed'
  readonly message: string
}

/** Fishing with the rod: one cast from where the bot stands, facing the water. */
export interface Fisher {
  /**
   * Takes the rod in hand, casts, waits for the bite, and reels in (the catch goes into the inventory). Aborting the
   * signal reels the line in and returns `aborted`; the caller uses that to give up on a cast that never bites.
   */
  cast(signal: AbortSignal): Promise<Result<void, FishFailure>>
}
