import type { Position } from './position.types.js'
import type { Result } from './result.js'

export interface PlaceFailure {
  readonly reason: 'not_connected' | 'no_item' | 'no_support' | 'failed'
  readonly message: string
}

export interface Placer {
  /** Puts a block from the inventory into the empty cell at `target`, against the block below it. */
  placeAt(itemName: string, target: Position): Promise<Result<void, PlaceFailure>>
  /**
   * Puts a block from the inventory into the empty cell next to `reference`, against its `face` (a unit vector that
   * points from the reference block to the cell: (0, 1, 0) puts it on top, (1, 0, 0) on the east side, ...). This is how
   * walls, ceilings, and torches on walls are placed.
   */
  placeAgainst(
    itemName: string,
    reference: Position,
    face: Position,
  ): Promise<Result<void, PlaceFailure>>
}
