import { z } from 'zod'
import type { Placement } from '../blueprint.types.js'

export const MAX_SIDE = 32
const side = (what: string) =>
  z
    .number()
    .int()
    .min(1)
    .max(MAX_SIDE)
    .describe(`${what}, in blocks (1 to ${String(MAX_SIDE)}).`)

export const widthParam = side('Size along the x axis (east-west)')
export const depthParam = side('Size along the z axis (north-south)')
export const heightParam = side('Height')
export const blockParam = (fallback: string) =>
  z
    .string()
    .min(1)
    .default(fallback)
    .describe(`Item name of the block to build with (default ${fallback}).`)

/** The cells on the outline of a width × depth rectangle at height `dy`, in walking order. */
export function outline(width: number, depth: number, dy: number, block: string): Placement[] {
  const cells: Placement[] = []
  for (let dx = 0; dx < width; dx += 1) {
    cells.push({ dx, dy, dz: 0, block })
    if (depth > 1) cells.push({ dx, dy, dz: depth - 1, block })
  }
  for (let dz = 1; dz < depth - 1; dz += 1) {
    cells.push({ dx: 0, dy, dz, block })
    if (width > 1) cells.push({ dx: width - 1, dy, dz, block })
  }
  return cells
}

/** Every cell of a width × depth rectangle at height `dy`. */
export function fill(width: number, depth: number, dy: number, block: string): Placement[] {
  const cells: Placement[] = []
  for (let dx = 0; dx < width; dx += 1)
    for (let dz = 0; dz < depth; dz += 1) cells.push({ dx, dy, dz, block })
  return cells
}
