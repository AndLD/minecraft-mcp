import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { EntityScanner } from '../../core/entity-scanner.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'

/** Blocks that hurt someone standing in or next to them. */
const HARMFUL = new Set(['lava', 'fire', 'soul_fire', 'cactus', 'magma_block', 'campfire'])
const HAZARD_RADIUS = 2
const HOSTILE_RADIUS = 12
const HOSTILE_SCAN = 40
/** Mobs the threat policy ignores. */
const HARMLESS_HOSTILES = new Set(['enderman'])
const DEEP_WATER = 3
const GROUND_SEARCH = 24

/**
 * Looks at the place where items lie and lists what could kill the bot there, in words. It reads only loaded chunks:
 * what is not loaded is not reported, so the caller looks again from close by.
 */
export class HazardAssessor {
  constructor(
    private readonly blocks: BlockScanner,
    private readonly entities: EntityScanner,
  ) {}

  assess(spot: Position): string[] {
    const hazards: string[] = []
    const harmful = this.harmfulBlocks(spot)
    if (harmful.length > 0)
      hazards.push(`${harmful.join(', ')} within ${String(HAZARD_RADIUS)} blocks`)
    if (this.waterDepth(spot) >= DEEP_WATER) hazards.push('deep water')
    if (this.noGroundBelow(spot)) hazards.push('no ground below (the void or a long fall)')
    const mobs = this.hostiles(spot)
    if (mobs.length > 0) hazards.push(`hostile mobs: ${mobs.join(', ')}`)
    return hazards
  }

  private harmfulBlocks(spot: Position): string[] {
    const found = new Set<string>()
    const [x, y, z] = [Math.floor(spot.x), Math.floor(spot.y), Math.floor(spot.z)]
    for (let dx = -HAZARD_RADIUS; dx <= HAZARD_RADIUS; dx += 1)
      for (let dy = -HAZARD_RADIUS; dy <= HAZARD_RADIUS; dy += 1)
        for (let dz = -HAZARD_RADIUS; dz <= HAZARD_RADIUS; dz += 1) {
          const name = this.blocks.blockAt({ x: x + dx, y: y + dy, z: z + dz })
          if (name !== undefined && HARMFUL.has(name)) found.add(name.replace('_', ' '))
        }
    return [...found].sort()
  }

  /** How many water blocks stack up from the spot upward and downward. */
  private waterDepth(spot: Position): number {
    const [x, y, z] = [Math.floor(spot.x), Math.floor(spot.y), Math.floor(spot.z)]
    const isWater = (at: number): boolean => this.blocks.blockAt({ x, y: at, z }) === 'water'
    if (!isWater(y)) return 0
    let depth = 1
    for (let up = y + 1; isWater(up) && depth < 16; up += 1) depth += 1
    for (let down = y - 1; isWater(down) && depth < 16; down -= 1) depth += 1
    return depth
  }

  private noGroundBelow(spot: Position): boolean {
    const [x, y, z] = [Math.floor(spot.x), Math.floor(spot.y), Math.floor(spot.z)]
    for (let below = 1; below <= GROUND_SEARCH; below += 1) {
      const solid = this.blocks.isSolid({ x, y: y - below, z })
      if (solid === undefined || solid) return false // not loaded, or ground: nothing to warn about
    }
    return true
  }

  private hostiles(spot: Position): string[] {
    const counts = new Map<string, number>()
    for (const entity of this.entities.nearby(HOSTILE_SCAN)) {
      if (entity.category !== 'hostile' || HARMLESS_HOSTILES.has(entity.name)) continue
      if (distanceBetween(entity.position, spot) > HOSTILE_RADIUS) continue
      counts.set(entity.name, (counts.get(entity.name) ?? 0) + 1)
    }
    return [...counts].map(([name, count]) => `${String(count)} ${name}`)
  }
}
