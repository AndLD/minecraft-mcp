import type { Position } from './position.types.js'
import type { Result } from './result.js'

/** What a button- or lever-like block is right now: its exact name and whether it is powered. */
export interface SwitchState {
  readonly name: string
  readonly powered: boolean
}

export type SwitchFailureReason = 'out_of_reach' | 'not_connected' | 'failed'

export interface SwitchFailure {
  readonly reason: SwitchFailureReason
  readonly message: string
}

/**
 * Reads and presses buttons and levers by right-clicking them. A pressure plate is powered by an entity
 * standing on it, not by a click, so it has no `press` action here; walking onto it is enough.
 */
export interface SwitchAccess {
  /** The block's name and powered state, or undefined when it is not loaded. */
  stateAt(position: Position): SwitchState | undefined
  /** Right-clicks the block, toggling it. The bot must be within reach. */
  press(position: Position, signal: AbortSignal): Promise<Result<void, SwitchFailure>>
}
