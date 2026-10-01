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

const isDoor = (name: string | undefined): boolean =>
  name !== undefined && (name.endsWith('_door') || name.endsWith('_fence_gate'))

const HORIZONTAL = [...DIRECTIONS]

/** Points for each solid block touching the bed sideways: a bed against a wall or in a corner leaves the room usable. */
const WALL_POINTS = 10
/** A bed next to a door blocks the way in, so such a spot only wins when nothing else fits. */
const DOOR_PENALTY = 100

function solidAt(blocks: BlockScanner, cell: Position): boolean {
  return blocks.isSolid(cell) === true && !isDoor(blocks.blockAt(cell))
}

/** How good a spot is: bed cells touching walls, minus a door beside the bed or where the bot stands. */
function score(blocks: BlockScanner, spot: BedSpot, around: Position): number {
  let walls = 0
  for (const cell of [spot.foot, spot.head])
    for (const step of HORIZONTAL) {
      const next = { x: cell.x + step.x, y: cell.y, z: cell.z + step.z }
      const own =
        (next.x === spot.foot.x && next.z === spot.foot.z) ||
        (next.x === spot.head.x && next.z === spot.head.z)
      const standing = next.x === spot.stand.x && next.z === spot.stand.z
      if (!own && !standing && solidAt(blocks, next)) walls += 1
    }
  let doors = 0
  for (const cell of [spot.foot, spot.head, spot.stand])
    for (const step of HORIZONTAL)
      for (const dy of [0, 1]) {
        const beside = { x: cell.x + step.x, y: cell.y + dy, z: cell.z + step.z }
        if (isDoor(blocks.blockAt(beside))) doors += 1
      }
  return walls * WALL_POINTS - (doors > 0 ? DOOR_PENALTY : 0) - distanceBetween(around, spot.foot)
}

/**
 * Looks for a place for a two-block bed near `around`: both cells free with solid ground and clear air above, and a
 * free cell behind the foot for the bot to stand on. Of all the spots it takes the best: against walls (a corner is
 * best), not beside a door, then nearest. Outside protected areas, except when `exact` names the foot cell: an
 * explicit request may put a bed into a protected place (the player's own house), in any of the four directions.
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
  const allowed = (cell: Position): boolean => exact || guard.protectedAt(cell) === undefined

  let best: { spot: BedSpot; points: number } | undefined
  for (const foot of cells) {
    if (!free(blocks, foot) || !open(blocks, foot) || !allowed(foot)) continue
    for (const step of DIRECTIONS) {
      const head = { x: foot.x + step.x, y: foot.y, z: foot.z + step.z }
      const stand = { x: foot.x - step.x, y: foot.y, z: foot.z - step.z }
      if (!(free(blocks, head) && open(blocks, head) && allowed(head) && free(blocks, stand)))
        continue
      const spot = { foot, head, stand }
      const points = score(blocks, spot, around)
      if (best === undefined || points > best.points) best = { spot, points }
    }
  }
  return best?.spot
}
