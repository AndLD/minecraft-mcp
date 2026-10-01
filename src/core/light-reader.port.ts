import type { Position } from './position.types.js'

export interface LightReader {
  /** Block light (torches, lava, glowstone; not sunlight) at a cell, 0 to 15. Undefined when the cell is not loaded. */
  blockLightAt(position: Position): number | undefined
}
