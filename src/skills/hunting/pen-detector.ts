import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Position } from '../../core/position.types.js'

const BARRIER = /(_fence|_fence_gate|_wall)$|^iron_bars$/

/** Fences, fence gates, walls, and iron bars: what a pen is made of. */
export const isPenBarrier = (name: string): boolean => BARRIER.test(name)
const LOOK_DISTANCE = 3
const DIRECTIONS: readonly Position[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
]

/**
 * Guesses whether an animal stands in a pen: fences, fence gates, or walls within a few blocks on at least three sides.
 * Natural terrain has none of these, so a pen is somebody's work.
 */
export class PenDetector {
  constructor(private readonly blocks: BlockScanner) {}

  isPenned(position: Position): boolean {
    const x = Math.floor(position.x)
    const y = Math.floor(position.y)
    const z = Math.floor(position.z)
    const sides = DIRECTIONS.filter((direction) => this.hasBarrier(x, y, z, direction))
    return sides.length >= 3
  }

  private hasBarrier(x: number, y: number, z: number, direction: Position): boolean {
    for (let step = 1; step <= LOOK_DISTANCE; step += 1) {
      const name = this.blocks.blockAt({
        x: x + direction.x * step,
        y,
        z: z + direction.z * step,
      })
      if (name !== undefined && isPenBarrier(name)) return true
    }
    return false
  }
}
