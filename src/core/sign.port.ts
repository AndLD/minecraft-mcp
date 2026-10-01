import type { Position } from './position.types.js'
import type { Result } from './result.js'

export type SignSide = 'front' | 'back'

/** The four compass directions a sign can face (the way its text points). */
export type SignFacing = 'north' | 'south' | 'east' | 'west'

export interface SignState {
  /** For example `oak_sign` (standing) or `oak_wall_sign`. */
  readonly name: string
  /** Four lines per side, as the server shows them right now (blank lines are empty strings). */
  readonly front: readonly string[]
  readonly back: readonly string[]
  /** A waxed sign cannot be edited, only broken. */
  readonly waxed: boolean
  /** Which way the text of the front points; for a standing sign the nearest compass direction. */
  readonly facing: SignFacing | undefined
}

export interface SignFailure {
  readonly reason: 'not_connected' | 'out_of_reach' | 'not_editable' | 'failed'
  readonly message: string
}

export interface SignAccess {
  /** The sign block at the position; undefined when it is not loaded or not a sign. */
  stateAt(position: Position): SignState | undefined
  /**
   * Writes the lines on one side. A sign the bot has just placed is already open for editing to it, so `reopen` is
   * false; for an existing sign `reopen` right-clicks it first, because since 1.20 the server accepts new text only
   * from the player whose editor it opened.
   */
  write(
    position: Position,
    side: SignSide,
    lines: readonly string[],
    reopen: boolean,
    signal: AbortSignal,
  ): Promise<Result<void, SignFailure>>
}
