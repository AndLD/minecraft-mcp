import type { Position } from '../../core/position.types.js'

/** A box in world coordinates, both corners included. */
export interface Bounds {
  readonly from: Position
  readonly to: Position
}
