import type { Position } from './position.types.js'

export function distanceBetween(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/** Rounds to one decimal, which is plenty for block coordinates shown to an agent. */
export function roundPosition(position: Position): Position {
  const round = (value: number): number => Math.round(value * 10) / 10
  return { x: round(position.x), y: round(position.y), z: round(position.z) }
}
