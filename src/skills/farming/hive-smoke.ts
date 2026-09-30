import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { CampfireAccess } from '../../core/campfire.port.js'
import type { Position } from '../../core/position.types.js'

/** The game smokes a hive from a lit campfire up to this many blocks straight below it. */
export const SMOKE_REACH = 5

const CAMPFIRES = new Set(['campfire', 'soul_campfire'])

/** The lit campfire that keeps the bees of a hive calm (straight below it, within reach), or undefined. */
export function smokeBelow(
  blocks: BlockScanner,
  campfires: CampfireAccess,
  hive: Position,
): Position | undefined {
  for (let down = 1; down <= SMOKE_REACH; down += 1) {
    const at = { x: hive.x, y: hive.y - down, z: hive.z }
    const name = blocks.blockAt(at)
    if (name !== undefined && CAMPFIRES.has(name) && campfires.stateAt(at) === 'lit') return at
  }
  return undefined
}

/**
 * A free cell below the hive, within smoke reach, to put a campfire in: open air over solid ground. The highest one
 * is taken (closest to the hive), so the campfire is always inside reach.
 */
export function campfireSpotBelow(blocks: BlockScanner, hive: Position): Position | undefined {
  for (let down = 1; down <= SMOKE_REACH; down += 1) {
    const at = { x: hive.x, y: hive.y - down, z: hive.z }
    const name = blocks.blockAt(at)
    if ((name === 'air' || name === 'cave_air') && blocks.isSolid({ ...at, y: at.y - 1 }) === true)
      return at
  }
  return undefined
}
