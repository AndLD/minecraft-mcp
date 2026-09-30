import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Position } from '../../core/position.types.js'

export type SurfaceResult =
  | { readonly kind: 'ground'; readonly position: Position }
  /** The column is not loaded, or its ground is out of the searched height range. */
  | { readonly kind: 'unknown' }
  /** Water or lava is all there is to stand on. */
  | { readonly kind: 'liquid' }

const LIQUIDS = new Set(['water', 'lava'])
const OPEN = new Set(['air', 'cave_air', 'void_air'])
const isLeaves = (name: string): boolean => name.endsWith('_leaves')

/** How far above and below the bot's own height the ground of a far column is looked for. */
export const SURFACE_RANGE = { up: 24, down: 40 }

/**
 * Finds the ground of a column: the first solid block from above that is not a treetop, with two open blocks over it.
 * Water and lava at the top of the column make it liquid, so the explorer goes round lakes and lava pools.
 */
export function findSurface(
  blocks: BlockScanner,
  x: number,
  z: number,
  aroundY: number,
): SurfaceResult {
  const top = Math.floor(aroundY) + SURFACE_RANGE.up
  const bottom = Math.floor(aroundY) - SURFACE_RANGE.down
  if (blocks.blockAt({ x, y: top, z }) === undefined) return { kind: 'unknown' }
  for (let y = top; y >= bottom; y -= 1) {
    const name = blocks.blockAt({ x, y, z })
    if (name === undefined) return { kind: 'unknown' }
    if (LIQUIDS.has(name)) return { kind: 'liquid' }
    if (OPEN.has(name) || isLeaves(name)) continue
    if (blocks.isSolid({ x, y, z }) !== true) continue
    const above = blocks.blockAt({ x, y: y + 1, z })
    const twoAbove = blocks.blockAt({ x, y: y + 2, z })
    if (above === undefined || twoAbove === undefined) return { kind: 'unknown' }
    if (!(OPEN.has(above) || isLeaves(above)) || !(OPEN.has(twoAbove) || isLeaves(twoAbove)))
      continue
    return { kind: 'ground', position: { x, y: y + 1, z } }
  }
  return { kind: 'unknown' }
}
