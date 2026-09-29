import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Liquid } from '../../core/bucket.port.js'
import type { Position } from '../../core/position.types.js'
import { EYE_HEIGHT } from '../../core/reach.js'
import { cellKey, WORK_REACH } from '../construction/standing-spot.js'

const SEARCH_RADIUS = 4
/** Standing in shallow water is harmless, so a wet spot only costs a little more than a dry one. */
const WET_PENALTY = 2
/** How the line from the eyes to the source is sampled, in blocks: fine enough not to skip a cell. */
const RAY_STEP = 0.2

export interface LiquidSpotRequest {
  readonly liquid: Liquid
  /** The source block to take. */
  readonly source: Position
  /** Where the bot is now. */
  readonly from: Position
}

const floorCell = (position: Position): Position => ({
  x: Math.floor(position.x),
  y: Math.floor(position.y),
  z: Math.floor(position.z),
})

/**
 * Chooses where the bot stands to fill a bucket. Any spot needs solid ground, room for the body (feet may be in shallow
 * water, the head must be clear), the source within reach, and a clear line to it (a wall in between would take the click). **For lava it is stricter**: no lava within
 * one block of the spot from just under its feet up to well above its head, so lava cannot flow onto it, and the
 * source must not lie higher than the head, so the bot takes it from the side and never from below. The bot's current
 * place is kept when it already fits.
 */
export class LiquidSpotFinder {
  constructor(private readonly blocks: BlockScanner) {}

  find(request: LiquidSpotRequest): Position | undefined {
    const here = floorCell(request.from)
    if (this.fits(here, request)) return request.from
    const source = floorCell(request.source)
    const candidates: { spot: Position; distance: number }[] = []
    for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += 1)
      for (let dz = -SEARCH_RADIUS; dz <= SEARCH_RADIUS; dz += 1)
        for (let dy = -1; dy <= 2; dy += 1) {
          const spot = { x: source.x + dx, y: source.y + dy, z: source.z + dz }
          if (!this.fits(spot, request)) continue
          candidates.push({
            spot,
            distance:
              Math.hypot(spot.x + 0.5 - request.from.x, spot.z + 0.5 - request.from.z) +
              Math.abs(spot.y - request.from.y) +
              (this.blocks.blockAt(spot) === 'water' ? WET_PENALTY : 0),
          })
        }
    const best = candidates.sort((a, b) => a.distance - b.distance)[0]
    return best === undefined
      ? undefined
      : { x: best.spot.x + 0.5, y: best.spot.y, z: best.spot.z + 0.5 }
  }

  /** Whether lava could reach a bot standing with its feet in this cell: the strict lava rule on its own. */
  lavaSafe(feet: Position): boolean {
    const spot = floorCell(feet)
    for (let dx = -1; dx <= 1; dx += 1)
      for (let dz = -1; dz <= 1; dz += 1)
        for (let dy = -1; dy <= 4; dy += 1) {
          const name = this.blocks.blockAt({ x: spot.x + dx, y: spot.y + dy, z: spot.z + dz })
          // An unloaded cell proves nothing, so it does not count as safe.
          if (name === undefined || name === 'lava') return false
        }
    return true
  }

  private fits(spot: Position, request: LiquidSpotRequest): boolean {
    const source = floorCell(request.source)
    if (cellKey(spot) === cellKey(source)) return false
    const head = { ...spot, y: spot.y + 1 }
    if (this.blocks.isSolid({ ...spot, y: spot.y - 1 }) !== true) return false
    if (this.blocks.isSolid(spot) !== false || this.blocks.isSolid(head) !== false) return false
    const feetName = this.blocks.blockAt(spot)
    const headName = this.blocks.blockAt(head)
    if (feetName === undefined || headName === undefined) return false
    // Feet in shallow water are fine (a bucket is often filled from flowing water), a head under water or feet in lava
    // or on a ladder are not.
    if (headName === 'water' || headName === 'lava' || feetName === 'lava' || feetName === 'ladder')
      return false
    if (!this.hasClearLine(spot, source)) return false
    if (request.liquid === 'lava') {
      if (source.y > spot.y + 1) return false
      if (!this.lavaSafe(spot)) return false
    }
    return true
  }

  /** The source is in reach, and no solid block lies between the eyes and it. */
  private hasClearLine(spot: Position, source: Position): boolean {
    const eyes = { x: spot.x + 0.5, y: spot.y + EYE_HEIGHT, z: spot.z + 0.5 }
    const centre = { x: source.x + 0.5, y: source.y + 0.5, z: source.z + 0.5 }
    const length = Math.hypot(centre.x - eyes.x, centre.y - eyes.y, centre.z - eyes.z)
    if (length > WORK_REACH) return false
    for (let travelled = 0; travelled < length; travelled += RAY_STEP) {
      const t = travelled / length
      const cell = floorCell({
        x: eyes.x + (centre.x - eyes.x) * t,
        y: eyes.y + (centre.y - eyes.y) * t,
        z: eyes.z + (centre.z - eyes.z) * t,
      })
      if (cellKey(cell) === cellKey(source)) return true
      if (this.blocks.isSolid(cell) !== false) return false
    }
    return true
  }
}
