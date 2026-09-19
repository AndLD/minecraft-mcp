import type { Position } from './position.types.js'
import type { Result } from './result.js'

export interface PlaceFailure {
  readonly reason: 'not_connected' | 'no_item' | 'no_support' | 'failed'
  readonly message: string
}

export interface Placer {
  /** Puts a block from the inventory into the empty cell at `target`, against the block below it. */
  placeAt(itemName: string, target: Position): Promise<Result<void, PlaceFailure>>
}
