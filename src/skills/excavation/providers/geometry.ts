import { z } from 'zod'
import type { Position } from '../../../core/position.types.js'

export const DIRECTIONS = ['north', 'east', 'south', 'west'] as const
export type Direction = (typeof DIRECTIONS)[number]

export const directionParam = z
  .enum(DIRECTIONS)
  .describe('Which way to dig: north (-z), east (+x), south (+z), or west (-x).')

/** Forward and to-the-right unit vectors (on the ground plane) for a heading. */
export const HEADINGS: Readonly<Record<Direction, { forward: Position; right: Position }>> = {
  north: { forward: { x: 0, y: 0, z: -1 }, right: { x: 1, y: 0, z: 0 } },
  east: { forward: { x: 1, y: 0, z: 0 }, right: { x: 0, y: 0, z: 1 } },
  south: { forward: { x: 0, y: 0, z: 1 }, right: { x: -1, y: 0, z: 0 } },
  west: { forward: { x: -1, y: 0, z: 0 }, right: { x: 0, y: 0, z: -1 } },
}

export const ALL_OFFSETS: readonly Position[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
]

/** Every neighbour offset except the given ones (the way the bot came from). */
export const probeAllBut = (...excluded: Position[]): Position[] =>
  ALL_OFFSETS.filter(
    (offset) => !excluded.some((e) => e.x === offset.x && e.y === offset.y && e.z === offset.z),
  )

export const negate = (v: Position): Position => ({ x: -v.x, y: -v.y, z: -v.z })

export const add = (a: Position, b: Position, scale = 1): Position => ({
  x: a.x + b.x * scale,
  y: a.y + b.y * scale,
  z: a.z + b.z * scale,
})

export const feetCell = (feet: Position): Position => ({
  x: Math.floor(feet.x),
  y: Math.floor(feet.y),
  z: Math.floor(feet.z),
})

export const MAX_SIDE = 32
export const side = (what: string) =>
  z
    .number()
    .int()
    .min(1)
    .max(MAX_SIDE)
    .describe(`${what}, in blocks (1 to ${String(MAX_SIDE)}).`)
