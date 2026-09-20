import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Position } from '../../core/position.types.js'
import { EYE_HEIGHT } from '../../core/reach.js'

/** Placing and breaking work well inside this reach (the game allows 4.5 from the eyes). */
export const WORK_REACH = 4
const SEARCH_RADIUS = 3
const FLUIDS = new Set(['water', 'lava'])
/** Walking further is better than standing inside the thing being built. */
const INSIDE_PENALTY = 50

export const cellKey = (position: Position): string =>
  `${String(Math.floor(position.x))},${String(Math.floor(position.y))},${String(Math.floor(position.z))}`

export interface SpotRequest {
  /** The cell to work on. */
  readonly target: Position
  /** Where the bot is now. */
  readonly from: Position
  /** Cells that will still get a block: the bot must not stand in one, or it would be in the way. */
  readonly reserved: ReadonlySet<string>
  /**
   * Cells the bot should stay out of when it has a choice (the inside of what is being built), so it does not end up
   * sealed in by the last blocks.
   */
  readonly avoid?: (cell: Position) => boolean
  /** The bot must stand in line with the target along this axis, one to three blocks away (see `WorkStep`). */
  readonly alignAxis?: 'x' | 'z'
}

/**
 * Chooses where the bot should stand to work on a cell: within reach of it, on solid ground, with room for its body,
 * not in a cell that is still to be built, and not next to lava. The bot's current place is kept when it already
 * fits, so it does not walk for nothing.
 */
export class StandingSpotChooser {
  constructor(private readonly blocks: BlockScanner) {}

  choose(request: SpotRequest): Position | undefined {
    const here = this.cell(request.from)
    const avoid = request.avoid ?? (() => false)
    const stayingPut = this.fits(here, request)
    if (stayingPut && !avoid(here)) return request.from

    const target = this.cell(request.target)
    const candidates: { spot: Position; distance: number }[] = []
    for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += 1)
      for (let dz = -SEARCH_RADIUS; dz <= SEARCH_RADIUS; dz += 1)
        for (let dy = -3; dy <= 1; dy += 1) {
          const spot = { x: target.x + dx, y: target.y + dy, z: target.z + dz }
          if (!this.fits(spot, request)) continue
          candidates.push({
            spot,
            distance:
              Math.hypot(spot.x + 0.5 - request.from.x, spot.z + 0.5 - request.from.z) +
              Math.abs(spot.y - request.from.y) +
              (avoid(spot) ? INSIDE_PENALTY : 0),
          })
        }
    const best = candidates.sort((a, b) => a.distance - b.distance)[0]
    // Nothing better outside: stay where the bot is, if that works.
    if (best === undefined || (stayingPut && avoid(best.spot)))
      return stayingPut ? request.from : undefined
    return { x: best.spot.x + 0.5, y: best.spot.y, z: best.spot.z + 0.5 }
  }

  /** In line with the target along the axis, one to three blocks away, at about the same height. */
  private inLine(spot: Position, target: Position, axis: 'x' | 'z'): boolean {
    const cell = this.cell(target)
    const across = axis === 'z' ? spot.x - cell.x : spot.z - cell.z
    const along = Math.abs(axis === 'z' ? spot.z - cell.z : spot.x - cell.x)
    return across === 0 && along >= 1 && along <= 3 && Math.abs(spot.y - cell.y) <= 1
  }

  private cell(position: Position): Position {
    return { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
  }

  private fits(spot: Position, request: SpotRequest): boolean {
    const head = { ...spot, y: spot.y + 1 }
    const below = { ...spot, y: spot.y - 1 }
    if (request.alignAxis !== undefined && !this.inLine(spot, request.target, request.alignAxis))
      return false
    if (request.reserved.has(cellKey(spot)) || request.reserved.has(cellKey(head))) return false
    if (cellKey(spot) === cellKey(request.target) || cellKey(head) === cellKey(request.target))
      return false
    if (this.blocks.isSolid(below) !== true) return false
    if (this.blocks.isSolid(spot) !== false || this.blocks.isSolid(head) !== false) return false
    const feet = this.blocks.blockAt(spot)
    if (feet !== undefined && FLUIDS.has(feet)) return false
    const eyes = { x: spot.x + 0.5, y: spot.y + EYE_HEIGHT, z: spot.z + 0.5 }
    const centre = {
      x: Math.floor(request.target.x) + 0.5,
      y: Math.floor(request.target.y) + 0.5,
      z: Math.floor(request.target.z) + 0.5,
    }
    if (Math.hypot(eyes.x - centre.x, eyes.y - centre.y, eyes.z - centre.z) > WORK_REACH)
      return false
    return !this.lavaNear(spot)
  }

  private lavaNear(spot: Position): boolean {
    for (let dx = -1; dx <= 1; dx += 1)
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dz = -1; dz <= 1; dz += 1)
          if (this.blocks.blockAt({ x: spot.x + dx, y: spot.y + dy, z: spot.z + dz }) === 'lava')
            return true
    return false
  }
}
