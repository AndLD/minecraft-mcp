import type { Position } from './position.types.js'

export interface ProtectedArea {
  readonly id: string
  readonly label: string
}

/** Tells which places the bot must never dig in (player builds, landmarks marked as protected). */
export interface AreaGuard {
  /** The protected area containing the position, if any. */
  protectedAt(position: Position): ProtectedArea | undefined
}
