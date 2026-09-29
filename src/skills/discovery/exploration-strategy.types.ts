import type { Position } from '../../core/position.types.js'

export interface ExplorationState {
  /** Where the search started; the distance limit is measured from here. */
  readonly origin: Position
  readonly current: Position
  /** Every place the bot has stood at, or tried to reach, since the search began. */
  readonly visited: readonly Position[]
  /** How far from the origin the search may go, in blocks. */
  readonly maxDistance: number
}

/** Chooses where to look next. Only the ground position matters: the skill finds the surface height. */
export interface ExplorationStrategy {
  /** The next place to go to, or null when nothing is left within the limit. */
  nextWaypoint(state: ExplorationState): Position | null
}
