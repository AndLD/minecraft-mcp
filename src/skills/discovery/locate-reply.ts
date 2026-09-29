import type { Position } from '../../core/position.types.js'

/** "The nearest minecraft:village_plains is at [-224, ~, 96] (123 blocks away)" → where. Height is unknown: `~`. */
export function parseLocateReply(reply: string): { x: number; z: number } | undefined {
  const match = /\[\s*(-?\d+)\s*,\s*(?:~|-?\d+)\s*,\s*(-?\d+)\s*\]/.exec(reply)
  if (match === null) return undefined
  return { x: Number(match[1]), z: Number(match[2]) }
}

export const withHeight = (place: { x: number; z: number }, y: number): Position => ({
  x: place.x,
  y,
  z: place.z,
})
