import type { Position } from './position.types.js'

/** A beehive (made by a player) or a bee nest (found in the world), and how full of honey it is. */
export interface HiveState {
  readonly kind: 'hive' | 'nest'
  /** 0 (empty) to 5 (ready: a bottle or shears take honey from it). */
  readonly honeyLevel: number
}

export interface HiveAccess {
  /** The state of the block at the position, or undefined when it is not a beehive or bee nest. */
  stateAt(position: Position): HiveState | undefined
}
