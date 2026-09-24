import type { Position } from './position.types.js'

/** A rail block as the world reports it. */
export interface RailState {
  /** `rail` or `powered_rail` (or another kind of rail). */
  readonly name: string
  /** The blockstate `shape`: `north_south`, `east_west`, `ascending_east`, `south_east`, ... */
  readonly shape: string | undefined
  /** Only powered rails carry it: whether they are powered right now. */
  readonly powered: boolean | undefined
}

/** Reads a rail block's shape and power from its blockstate. */
export interface RailAccess {
  /** The block's rail state, or undefined when it is not loaded or not a rail. */
  stateAt(position: Position): RailState | undefined
}
