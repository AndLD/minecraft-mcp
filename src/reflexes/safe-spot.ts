import type { BlockScanner } from '../core/block-scanner.port.js'
import type { Position } from '../core/position.types.js'

export type Hazard = 'lava' | 'water'

const MAX_RADIUS = 8
const SEARCH_UP = 2
const SEARCH_DOWN = 3

/** Finds the nearest place to stand that is away from lava (and, when asked, from water). */
export class SafeSpotFinder {
  constructor(private readonly blocks: BlockScanner) {}

  find(from: Position, avoid: readonly Hazard[]): Position | undefined {
    const cx = Math.floor(from.x)
    const cz = Math.floor(from.z)
    const cy = Math.floor(from.y)
    for (let radius = 1; radius <= MAX_RADIUS; radius += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue // only the ring at this distance
          for (let y = cy + SEARCH_UP; y >= cy - SEARCH_DOWN; y -= 1) {
            const spot = { x: cx + dx, y, z: cz + dz }
            if (this.isSafeToStand(spot, avoid))
              return { x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 }
          }
        }
      }
    }
    return undefined
  }

  private isSafeToStand(spot: Position, avoid: readonly Hazard[]): boolean {
    const below = { x: spot.x, y: spot.y - 1, z: spot.z }
    const head = { x: spot.x, y: spot.y + 1, z: spot.z }
    if (this.blocks.isSolid(below) !== true) return false
    if (this.blocks.isSolid(spot) !== false || this.blocks.isSolid(head) !== false) return false
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const name = this.blocks.blockAt({ x: spot.x + dx, y: spot.y + dy, z: spot.z + dz })
          if (name !== undefined && avoid.includes(name as Hazard)) return false
        }
      }
    }
    return true
  }
}
