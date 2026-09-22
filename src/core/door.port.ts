import type { Position } from './position.types.js'
import type { Result } from './result.js'

/** What a door-like block is right now: its exact name and whether it is open. */
export interface DoorState {
  readonly name: string
  readonly open: boolean
}

export type DoorFailureReason = 'out_of_reach' | 'not_connected' | 'failed'

export interface DoorFailure {
  readonly reason: DoorFailureReason
  readonly message: string
}

/** Reads and toggles doors, fence gates, and trapdoors (wooden or iron) by right-clicking them. */
export interface DoorAccess {
  /** The block's name and open state, or undefined when it is not loaded. */
  stateAt(position: Position): DoorState | undefined
  /** Right-clicks the block, toggling it open or closed. The bot must be within reach. */
  toggle(position: Position, signal: AbortSignal): Promise<Result<void, DoorFailure>>
}
