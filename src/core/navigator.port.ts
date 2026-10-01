import type { Position } from './position.types.js'
import type { Result } from './result.js'

export type NavigationFailureReason =
  | 'unreachable'
  | 'stuck'
  | 'timeout'
  | 'aborted'
  | 'target_not_found'
  | 'not_connected'
  /** A closed door, gate, or trapdoor would not open after two tries. */
  | 'door_stuck'
  /** An iron door or trapdoor blocks the way; no switch was found for it, or the switch policy is "never". */
  | 'needs_switch'
  /** An iron door or trapdoor blocks the way and switches were found nearby; the switch policy is "ask". */
  | 'iron_door_blocked'

export interface NavigationFailure {
  readonly reason: NavigationFailureReason
  readonly message: string
}

export interface NavigationProgress {
  readonly position: Position
  /** Straight-line distance to the goal, in blocks. Undefined when there is no fixed goal (following). */
  readonly distanceRemaining: number | undefined
}

export interface NavigationOptions {
  /** Aborting stops the bot immediately. */
  readonly signal: AbortSignal
  readonly onProgress?: (progress: NavigationProgress) => void
  /** Close a door or gate behind the bot once it has passed through it. Default true. */
  readonly closeDoors?: boolean
}

export interface Navigator {
  /** Walks to within `within` blocks of the position. Resolves with where the bot ended up. */
  goToPosition(
    target: Position,
    within: number,
    options: NavigationOptions,
  ): Promise<Result<Position, NavigationFailure>>
  /** Walks to within `within` blocks of where the player currently is. */
  goToPlayer(
    player: string,
    within: number,
    options: NavigationOptions,
  ): Promise<Result<Position, NavigationFailure>>
  /** Keeps following the player at about `distance` blocks until aborted (ok) or the player is lost (failure). */
  follow(
    player: string,
    distance: number,
    options: NavigationOptions,
  ): Promise<Result<void, NavigationFailure>>
}
