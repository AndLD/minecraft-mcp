import type { Position } from '../../core/position.types.js'
import type { Random } from '../../core/random.port.js'
import type { ExplorationState, ExplorationStrategy } from './exploration-strategy.types.js'

/** Distance between waypoints: short enough that the next one is inside the chunks the server has sent. */
export const WAYPOINT_STEP = 40

const across = (a: Position, b: Position): number => Math.hypot(a.x - b.x, a.z - b.z)
export const keyOf = (i: number, j: number): string => `${String(i)},${String(j)}`
export const cellOf = (position: Position, origin: Position, step: number) => ({
  i: Math.round((position.x - origin.x) / step),
  j: Math.round((position.z - origin.z) / step),
})

/** A square spiral around the start: every cell of the grid, ring by ring, so no ground is left out. */
export class SpiralExplorer implements ExplorationStrategy {
  private index = 0

  constructor(private readonly step = WAYPOINT_STEP) {}

  nextWaypoint(state: ExplorationState): Position | null {
    for (;;) {
      this.index += 1
      const { i, j } = spiralCell(this.index)
      // Every cell of a ring is at least this far out, so once a ring is past the limit the rest is too.
      if (Math.max(Math.abs(i), Math.abs(j)) * this.step > state.maxDistance) return null
      // The corners of a square ring reach further than its sides: keep to the circle.
      if (Math.hypot(i, j) * this.step > state.maxDistance) continue
      return {
        x: state.origin.x + i * this.step,
        y: state.current.y,
        z: state.origin.z + j * this.step,
      }
    }
  }
}

/** The n-th cell of the spiral (0 is the centre): right, up, left, left, down, down, right... */
export function spiralCell(n: number): { i: number; j: number } {
  if (n === 0) return { i: 0, j: 0 }
  const ring = Math.ceil((Math.sqrt(n + 1) - 1) / 2)
  const side = 2 * ring
  const start = (2 * ring - 1) ** 2
  const offset = n - start
  const lap = Math.floor(offset / side)
  const along = offset % side
  switch (lap) {
    case 0:
      return { i: ring, j: -ring + 1 + along }
    case 1:
      return { i: ring - 1 - along, j: ring }
    case 2:
      return { i: -ring, j: ring - 1 - along }
    default:
      return { i: -ring + 1 + along, j: -ring }
  }
}

/**
 * Grows the searched area like a blob: it only goes to cells beside ground already visited (the frontier), and among
 * those takes the one that is cheapest to add, close to the start and close to where the bot is. Heading for the
 * nearest cell alone would wander off in one direction and leave holes behind it.
 */
export class FrontierExplorer implements ExplorationStrategy {
  constructor(
    private readonly random: Random,
    private readonly step = WAYPOINT_STEP,
  ) {}

  nextWaypoint(state: ExplorationState): Position | null {
    const seen = new Set<string>()
    const cells: { i: number; j: number }[] = []
    for (const place of state.visited) {
      const cell = cellOf(place, state.origin, this.step)
      if (!seen.has(keyOf(cell.i, cell.j))) {
        seen.add(keyOf(cell.i, cell.j))
        cells.push(cell)
      }
    }
    const frontier = new Map<string, { i: number; j: number }>()
    for (const cell of cells) {
      for (let di = -1; di <= 1; di += 1) {
        for (let dj = -1; dj <= 1; dj += 1) {
          const i = cell.i + di
          const j = cell.j + dj
          if (seen.has(keyOf(i, j)) || Math.hypot(i, j) * this.step > state.maxDistance) continue
          frontier.set(keyOf(i, j), { i, j })
        }
      }
    }
    const here = cellOf(state.current, state.origin, this.step)
    const cost = (cell: { i: number; j: number }): number =>
      Math.hypot(cell.i, cell.j) + Math.hypot(cell.i - here.i, cell.j - here.j)
    let cheapest = Number.POSITIVE_INFINITY
    for (const cell of frontier.values()) cheapest = Math.min(cheapest, cost(cell))
    const best = [...frontier.values()].filter((cell) => cost(cell) - cheapest < 1e-6)
    const pick = best[Math.floor(this.random.next() * best.length)]
    return pick === undefined
      ? null
      : {
          x: state.origin.x + pick.i * this.step,
          y: state.current.y,
          z: state.origin.z + pick.j * this.step,
        }
  }
}

/** Walks in short hops straight towards a place too far to see (one the server named). */
export class TowardExplorer implements ExplorationStrategy {
  constructor(
    private readonly target: Position,
    private readonly step = WAYPOINT_STEP,
    private readonly arrivedWithin = 8,
  ) {}

  nextWaypoint(state: ExplorationState): Position | null {
    const left = across(state.current, this.target)
    if (left <= this.arrivedWithin) return null
    const share = Math.min(1, this.step / left)
    return {
      x: Math.round(state.current.x + (this.target.x - state.current.x) * share),
      y: state.current.y,
      z: Math.round(state.current.z + (this.target.z - state.current.z) * share),
    }
  }
}
