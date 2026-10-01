import { DIRECTIONS, HEADINGS, type Direction } from '../excavation/providers/geometry.js'

/**
 * Snaps a yaw (radians, the same convention as `LookTarget`: 0 faces -z, positive turns towards -x) to the
 * nearest of the four cardinal directions, so a plot always lines up with the world grid instead of the exact
 * angle the player happened to be looking.
 */
export function directionFromYaw(yaw: number): Direction {
  const dx = -Math.sin(yaw)
  const dz = -Math.cos(yaw)
  let best: Direction = DIRECTIONS[0]
  let bestDot = -Infinity
  for (const direction of DIRECTIONS) {
    const { forward } = HEADINGS[direction]
    const dot = dx * forward.x + dz * forward.z
    if (dot > bestDot) {
      bestDot = dot
      best = direction
    }
  }
  return best
}

export interface Rectangle {
  readonly x1: number
  readonly z1: number
  readonly x2: number
  readonly z2: number
}

/**
 * The rectangle that starts at `start` and runs `length` blocks in `direction`, `width` blocks to the right of it
 * (as seen facing that direction), corners included.
 */
export function rectangleFromFacing(
  start: { readonly x: number; readonly z: number },
  direction: Direction,
  width: number,
  length: number,
): Rectangle {
  const { forward, right } = HEADINGS[direction]
  const corners = [
    start,
    { x: start.x + forward.x * (length - 1), z: start.z + forward.z * (length - 1) },
    { x: start.x + right.x * (width - 1), z: start.z + right.z * (width - 1) },
    {
      x: start.x + forward.x * (length - 1) + right.x * (width - 1),
      z: start.z + forward.z * (length - 1) + right.z * (width - 1),
    },
  ]
  return {
    x1: Math.min(...corners.map((c) => c.x)),
    z1: Math.min(...corners.map((c) => c.z)),
    x2: Math.max(...corners.map((c) => c.x)),
    z2: Math.max(...corners.map((c) => c.z)),
  }
}
