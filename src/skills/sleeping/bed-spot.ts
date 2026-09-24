import type { AreaGuard } from '../../core/area-guard.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import { isOpenAir, isReplaceable } from '../construction/block-match.js'

export interface BedSpot {
  /** The cell of the foot end (where the pillow is not). */
  readonly foot: Position
  /** The cell of the head end, one step from the foot in `direction`. */
  readonly head: Position
  /** Where the bot stands to place it: behind the foot, looking along the bed. */
  readonly stand: Position
}

const DIRECTIONS = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 },
] as const

const SEARCH_RADIUS = 6

/** A cell a block can go into (or a person stand in) with something solid to stand on. */
function free(blocks: BlockScanner, cell: Position): boolean {
  const here = blocks.blockAt(cell)
  return (
    (isOpenAir(here) || isReplaceable(here)) &&
    here !== 'water' &&
    blocks.isSolid({ x: cell.x, y: cell.y - 1, z: cell.z }) === true
  )
}

function open(blocks: BlockScanner, cell: Position): boolean {
  const above = blocks.blockAt({ x: cell.x, y: cell.y + 1, z: cell.z })
  return isOpenAir(above) || isReplaceable(above)
}

/**
 * Looks for a place for a two-block bed near `around`: both cells free with solid ground and clear air above,
 * outside protected areas, and a spot behind the foot for the bot to stand on. Nearest first; `exact` allows only
 * that foot cell (in any of the four directions).
 */
export function findBedSpot(
  blocks: BlockScanner,
  guard: AreaGuard,
  around: Position,
  exact: boolean,
): BedSpot | undefined {
  const cells: Position[] = []
  if (exact) cells.push(around)
  else
    for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += 1)
      for (let dz = -SEARCH_RADIUS; dz <= SEARCH_RADIUS; dz += 1)
        cells.push({ x: around.x + dx, y: around.y, z: around.z + dz })
  cells.sort((a, b) => distanceBetween(around, a) - distanceBetween(around, b))

  for (const foot of cells) {
    if (!free(blocks, foot) || !open(blocks, foot) || guard.protectedAt(foot) !== undefined)
      continue
    for (const step of DIRECTIONS) {
      const head = { x: foot.x + step.x, y: foot.y, z: foot.z + step.z }
      const stand = { x: foot.x - step.x, y: foot.y, z: foot.z - step.z }
      if (
        free(blocks, head) &&
        open(blocks, head) &&
        guard.protectedAt(head) === undefined &&
        free(blocks, stand)
      )
        return { foot, head, stand }
    }
  }
  return undefined
}
