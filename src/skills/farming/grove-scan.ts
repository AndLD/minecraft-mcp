import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { FarmEntry, GroveSpot } from '../../state/farm-registry.js'
import { insideBounds } from './farm-area.types.js'
import { isLogName, isPlantableGround, isSaplingName } from './tree-table.js'

export type SiteState = 'grown' | 'sapling' | 'empty'

export interface GroveSite {
  readonly spot: GroveSpot
  readonly state: SiteState
}

const SEARCH_DISTANCE = 64
const MAX_FOUND = 500

export const spotCells = (spot: GroveSpot): readonly { x: number; y: number; z: number }[] => {
  const result: { x: number; y: number; z: number }[] = []
  for (let dx = 0; dx < spot.size; dx += 1)
    for (let dz = 0; dz < spot.size; dz += 1) result.push({ x: spot.x + dx, y: spot.y, z: spot.z + dz })
  return result
}

/** What stands at one planting spot right now: a grown trunk, a young sapling, or nothing. */
export function stateOfSpot(spot: GroveSpot, blocks: BlockScanner): SiteState {
  const names = spotCells(spot).map((cell) => blocks.blockAt(cell))
  if (names.some((name) => name !== undefined && isLogName(name))) return 'grown'
  if (names.some((name) => name !== undefined && isSaplingName(name))) return 'sapling'
  return 'empty'
}

/**
 * The trees of a grove. With recorded spots (the grove was planted by `plant_trees`), each spot is checked; without
 * (a grove the player registered by hand) the trunks and saplings standing inside its bounds are found instead, so
 * only their numbers are known, never how many spots are empty.
 */
export function scanGrove(entry: FarmEntry, blocks: BlockScanner): readonly GroveSite[] {
  if (entry.spots !== null)
    return entry.spots.map((spot) => ({ spot, state: stateOfSpot(spot, blocks) }))

  const names = blocks.knownBlockNames().filter((name) => isSaplingName(name) || isLogName(name))
  if (names.length === 0) return []
  const sites: GroveSite[] = []
  for (const block of blocks.findBlocks({ names, maxDistance: SEARCH_DISTANCE, count: MAX_FOUND })) {
    const { x, y, z } = block.position
    if (!insideBounds(block.position, entry.bounds)) continue
    if (isSaplingName(block.name)) {
      sites.push({ spot: { x, y, z, size: 1 }, state: 'sapling' })
      continue
    }
    const below = blocks.blockAt({ x, y: y - 1, z })
    if (below !== undefined && isPlantableGround(below))
      sites.push({ spot: { x, y, z, size: 1 }, state: 'grown' })
  }
  return sites
}
