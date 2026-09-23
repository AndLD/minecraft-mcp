import type { Position } from '../../core/position.types.js'

/** A box in world coordinates, both corners included. */
export interface Bounds {
  readonly from: Position
  readonly to: Position
}

/**
 * Whether a position's block cell falls inside `bounds` (x/z only: farms are checked by footprint). Floors first:
 * an entity's own position is a fraction (a cow standing at x = 13.87), and comparing that raw against integer
 * block bounds can flip the answer as it wanders within the very block still inside the pen (found by this
 * feature's own e2e test, where a freshly bred calf was "inside" one check and "outside" the next).
 */
export function insideBounds(position: { readonly x: number; readonly z: number }, bounds: Bounds): boolean {
  const x = Math.floor(position.x)
  const z = Math.floor(position.z)
  return x >= bounds.from.x && x <= bounds.to.x && z >= bounds.from.z && z <= bounds.to.z
}
