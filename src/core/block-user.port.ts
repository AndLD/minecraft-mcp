import type { Position } from './position.types.js'
import type { Result } from './result.js'

/** Right-clicking a block with an item in hand: bone meal on a crop, anything on a composter. */
export interface BlockUser {
  /**
   * Faces the block and right-clicks it, holding `item` from the inventory first; with `item` undefined the click
   * is made with whatever is in hand (taking the bone meal out of a full composter needs no item).
   */
  use(position: Position, item: string | undefined): Promise<Result<void>>
}
