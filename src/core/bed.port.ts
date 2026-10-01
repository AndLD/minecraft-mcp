import type { Position } from './position.types.js'
import type { Result } from './result.js'

export interface BedState {
  /** For example `red_bed`. */
  readonly name: string
  readonly part: 'head' | 'foot' | undefined
  readonly occupied: boolean
}

export interface BedFailure {
  readonly reason: 'not_connected' | 'out_of_reach' | 'failed'
  readonly message: string
}

export interface BedAccess {
  /** The bed block at the position; undefined when it is not loaded or not a bed. */
  stateAt(position: Position): BedState | undefined
  /**
   * Right-clicks the bed and returns the server's lines that arrive within a moment (chat and action bar): "Respawn
   * point set" is how the game confirms a bed became the respawn point. At night the click also lies the bot down.
   */
  use(position: Position, signal: AbortSignal): Promise<Result<readonly string[], BedFailure>>
}
