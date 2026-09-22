import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Rectangle } from './facing.js'

const key = (x: number, z: number): string => `${String(x)},${String(z)}`

export interface HeightSurvey {
  /** Column key (`"x,z"`) to the y of its topmost solid block. */
  readonly heights: ReadonlyMap<string, number>
  readonly min: number
  readonly max: number
  /** The height that moves the fewest blocks in total if the plot were leveled there. */
  readonly median: number
}

/**
 * The topmost solid block of every column in `rect`, scanned from `topY` down to `bottomY` (inclusive). A column
 * with nothing solid in range (an open shaft, an unloaded chunk) is recorded at `bottomY`, the lowest it could be.
 */
export function surveyHeights(
  blocks: BlockScanner,
  rect: Rectangle,
  topY: number,
  bottomY: number,
): HeightSurvey {
  const heights = new Map<string, number>()
  for (let x = rect.x1; x <= rect.x2; x += 1) {
    for (let z = rect.z1; z <= rect.z2; z += 1) {
      let found = bottomY
      for (let y = topY; y >= bottomY; y -= 1) {
        if (blocks.isSolid({ x, y, z }) === true) {
          found = y
          break
        }
      }
      heights.set(key(x, z), found)
    }
  }
  const sorted = [...heights.values()].sort((a, b) => a - b)
  const first = sorted[0] ?? bottomY
  const last = sorted[sorted.length - 1] ?? bottomY
  const median = sorted[Math.floor(sorted.length / 2)] ?? bottomY
  return { heights, min: first, max: last, median }
}
