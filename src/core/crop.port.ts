import type { Position } from './position.types.js'

/** A growing crop's block name and how ripe it is (0 = just planted; the block's own max age is fully grown). */
export interface CropState {
  readonly name: string
  readonly age: number
}

/** Reads a crop block's growth stage from its blockstate. */
export interface CropAccess {
  /** The crop's name and age, or undefined when the block is not loaded or carries no age property. */
  stateAt(position: Position): CropState | undefined
}
