import type { Position } from './position.types.js'

export interface BiomeReader {
  /** The biome at a block, for example `desert`. Undefined when the block is not loaded. */
  biomeAt(position: Position): string | undefined
  /** Every biome name the game knows. Empty while not connected. */
  knownBiomeNames(): readonly string[]
}
