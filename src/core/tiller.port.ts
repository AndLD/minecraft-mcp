import type { Position } from './position.types.js'
import type { Result } from './result.js'

export type TillFailureReason = 'out_of_reach' | 'not_connected' | 'no_hoe' | 'failed'

export interface TillFailure {
  readonly reason: TillFailureReason
  readonly message: string
}

/** Turns dirt or grass into farmland by right-clicking it with a hoe. */
export interface Tiller {
  /** Equips a hoe from the inventory and right-clicks the block. The bot must be within reach. */
  till(position: Position, signal: AbortSignal): Promise<Result<void, TillFailure>>
}
