import type { Position } from './position.types.js'
import type { Result } from './result.js'

export type SleepFailureReason =
  | 'not_connected'
  | 'not_a_bed'
  | 'not_night'
  | 'monsters_nearby'
  | 'too_far'
  | 'occupied'
  | 'obstructed'
  | 'failed'

export interface SleepFailure {
  readonly reason: SleepFailureReason
  readonly message: string
}

/** Getting into a bed and out of it again. */
export interface Sleeper {
  isSleeping(): boolean
  /** Lies down in the bed at `bed` (the bot must be within reach). Resolves once the bot is in bed. */
  sleep(bed: Position): Promise<Result<void, SleepFailure>>
  /** Gets out of bed. Does nothing when the bot is not sleeping. */
  wake(): Promise<void>
}
