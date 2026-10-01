import type { Position } from './position.types.js'
import type { Result } from './result.js'

/** A campfire block: burning, out (put out by water or rain, or never lit), or not a campfire at all. */
export type CampfireState = 'lit' | 'out' | 'none'

export interface CampfireAccess {
  stateAt(position: Position): CampfireState
  /**
   * Puts one item from the inventory on the campfire (a right-click with it in hand). Fails when the campfire is full
   * or does not take the item. The item pops out beside the fire when it is cooked.
   */
  put(position: Position, item: string): Promise<Result<void>>
}
