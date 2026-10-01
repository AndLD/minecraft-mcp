import type { AreaGuard } from '../../core/area-guard.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Position } from '../../core/position.types.js'

const SEARCH_DISTANCE = 48
const MAX_WATER = 300
/** How far from the water the bot may stand: the bobber flies a few blocks, and it must not stand at the edge. */
const MIN_STAND = 2
const MAX_STAND = 4.5

export interface FishingSpot {
  /** The feet cell to stand in. */
  readonly stand: Position
  /** The water cell to cast at. */
  readonly water: Position
}

const FLUIDS = new Set(['water', 'lava'])
const AROUND = [-1, 0, 1] as const

/**
 * A place to fish: open water at least 3 by 3 blocks wide (a 1-block stream is refused), and firm ground of the same
 * level 2 to 4 blocks away with room to stand, outside protected areas and not beside lava. The nearest water that has
 * such ground wins, and among its standing places the one nearest to `from`.
 */
export function findFishingSpot(
  blocks: BlockScanner,
  guard: AreaGuard,
  from: Position,
): FishingSpot | undefined {
  const water = blocks
    .findBlocks({ names: ['water'], maxDistance: SEARCH_DISTANCE, count: MAX_WATER })
    .map((block) => block.position)
  for (const cell of water) {
    if (!isOpenPool(blocks, cell)) continue
    let best: { stand: Position; distance: number } | undefined
    for (let dx = -4; dx <= 4; dx += 1)
      for (let dz = -4; dz <= 4; dz += 1) {
        const across = Math.hypot(dx, dz)
        if (across < MIN_STAND || across > MAX_STAND) continue
        const stand = { x: cell.x + dx, y: cell.y + 1, z: cell.z + dz }
        if (!canStand(blocks, guard, stand)) continue
        const distance = Math.hypot(stand.x - from.x, stand.y - from.y, stand.z - from.z)
        if (best === undefined || distance < best.distance) best = { stand, distance }
      }
    if (best !== undefined) return { stand: best.stand, water: cell }
  }
  return undefined
}

/** Water all around in a 3 by 3 square with air on top of the middle: a bobber has room to float. */
function isOpenPool(blocks: BlockScanner, cell: Position): boolean {
  for (const dx of AROUND)
    for (const dz of AROUND)
      if (blocks.blockAt({ x: cell.x + dx, y: cell.y, z: cell.z + dz }) !== 'water') return false
  const above = blocks.blockAt({ ...cell, y: cell.y + 1 })
  return above === 'air' || above === 'cave_air'
}

function canStand(blocks: BlockScanner, guard: AreaGuard, feet: Position): boolean {
  const below = { ...feet, y: feet.y - 1 }
  if (blocks.isSolid(below) !== true) return false
  const name = blocks.blockAt(below)
  if (name === undefined || FLUIDS.has(name)) return false
  if (blocks.isSolid(feet) !== false || blocks.isSolid({ ...feet, y: feet.y + 1 }) !== false)
    return false
  if (guard.protectedAt(feet) !== undefined) return false
  for (const dx of AROUND)
    for (const dz of AROUND)
      if (blocks.blockAt({ x: feet.x + dx, y: feet.y, z: feet.z + dz }) === 'lava') return false
  return blocks.blockAt(feet) !== 'water'
}
