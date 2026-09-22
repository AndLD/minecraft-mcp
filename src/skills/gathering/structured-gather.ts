import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Position } from '../../core/position.types.js'

/**
 * Plain terrain blocks a structured dig may target: one-for-one from a single break, and simply the ground, so
 * nothing needs finding first (unlike ore, which is dug wherever it happens to be, not planned around).
 */
const TERRAIN_BLOCKS = new Set(['dirt', 'stone', 'cobblestone', 'sand', 'gravel', 'netherrack'])

export function isTerrainBlock(name: string): boolean {
  return TERRAIN_BLOCKS.has(name)
}

/** No side of the footprint grows past this many blocks. */
const MAX_SIDE = 5
/** Prefer a wider footprint over a deeper one past this many layers. */
const PREFERRED_MAX_DEPTH = 4
/** How far down to look for how deep the matching block actually goes, before widening instead of digging on. */
const PROBE_DEPTH = 8

export interface QuarrySize {
  readonly width: number
  readonly length: number
  readonly depth: number
}

/**
 * A small, roughly square footprint and a depth whose cell count is close to `count`, biased toward width over
 * depth (never past `maxDepth`), and never wider than `MAX_SIDE`.
 */
function sizeFor(count: number, maxDepth: number): QuarrySize {
  let side = 1
  while (side < MAX_SIDE && Math.ceil(count / (side * side)) > maxDepth) side += 1
  const depth = Math.max(1, Math.min(maxDepth, Math.ceil(count / (side * side))))
  return { width: side, length: side, depth }
}

/** How many layers straight down from `origin` are still the same block, up to `limit`. */
function matchingDepth(
  blocks: BlockScanner,
  origin: Position,
  block: string,
  limit: number,
): number {
  let depth = 0
  for (; depth < limit; depth += 1) {
    const name = blocks.blockAt({ x: origin.x, y: origin.y - depth, z: origin.z })
    if (name !== block) break
  }
  return depth
}

/**
 * The quarry size to dig for `count` of `block` starting at `origin`: a real quarry fills whatever the ground
 * actually holds, so if the matching block only goes a few layers deep here, the footprint widens instead of
 * digging on into whatever comes next (stone under a shallow dirt layer, for example).
 */
export function structuredSizeFor(
  blocks: BlockScanner,
  origin: Position,
  block: string,
  count: number,
): QuarrySize {
  const natural = Math.max(1, matchingDepth(blocks, origin, block, PROBE_DEPTH))
  return sizeFor(count, Math.min(PREFERRED_MAX_DEPTH, natural))
}
