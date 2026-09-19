/** Immutable world position. Never pass mutable Mineflayer `Vec3` across layers. */
export interface Position {
  readonly x: number
  readonly y: number
  readonly z: number
}
