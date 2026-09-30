import type { Position } from './position.types.js'

export interface ComposterAccess {
  /** The composter's fill level, 0 (empty) to 8 (ready to empty); undefined when the block there is not one. */
  levelAt(position: Position): number | undefined
}
