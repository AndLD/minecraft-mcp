import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { LookFace, LookTarget } from '../../core/container.port.js'
import type { EntityScanner } from '../../core/entity-scanner.port.js'
import type { Position } from '../../core/position.types.js'
import { HEADINGS, type Direction } from './providers/geometry.js'

/** How far above and below the hit block the floor is searched for, in the column in front of the wall. */
const SEARCH_ABOVE = 3
const SEARCH_BELOW = 6

/** The direction a room digs into the wall: straight in, opposite the face the player's ray hit. */
const DIG_DIRECTION: Readonly<Partial<Record<LookFace, Direction>>> = {
  north: 'south',
  south: 'north',
  east: 'west',
  west: 'east',
}

export interface WallResolveInput {
  /** Whose look (and, as a fallback, standing level) to use. */
  readonly player: string
  /** The wall block, when not read from the look. Give both this and `direction`, or neither. */
  readonly at?: Position | undefined
  /** The direction to dig, when not read from the look (opposite the face looked at). */
  readonly direction?: Direction | undefined
}

export type WallResolveResult =
  | { readonly ok: true; readonly origin: Position; readonly direction: Direction }
  | {
      readonly ok: false
      readonly reason: 'no_target' | 'not_a_wall'
      readonly message: string
    }

/** What a caller needs from `WallTarget` (role-based, so a test can fake just this). */
export interface WallResolver {
  resolve(input: WallResolveInput): WallResolveResult
}

/**
 * Turns "the wall the player is looking at" into where a room's entrance starts: the wall block's own column, at
 * the walkable floor level in front of it (so the entrance sits at floor height whatever the player was looking
 * at), and the direction to dig (straight into the wall, opposite the face that was hit). A look at the floor or
 * the ceiling is not a wall. `at` and `direction` (either or both) skip reading the look when the request already
 * names them.
 */
export class WallTarget implements WallResolver {
  constructor(
    private readonly look: LookTarget,
    private readonly blocks: BlockScanner,
    private readonly entities: EntityScanner,
  ) {}

  resolve(input: WallResolveInput): WallResolveResult {
    let at = input.at
    let direction = input.direction
    if (at === undefined || direction === undefined) {
      const hit = this.look.blockLookedAt(input.player)
      if (hit === undefined)
        return {
          ok: false,
          reason: 'no_target',
          message: `${input.player} is not looking at any block within reach, or is out of the bot's view. Ask them to look at the wall to dig into, or give at and direction.`,
        }
      const faceDirection = DIG_DIRECTION[hit.face]
      if (faceDirection === undefined)
        return {
          ok: false,
          reason: 'not_a_wall',
          message: `That is the ${hit.face}, not a wall. Ask ${input.player} to look at a wall to dig a room into.`,
        }
      at ??= hit.position
      direction ??= faceDirection
    }
    return { ok: true, origin: { x: at.x, y: this.findFloor(at, direction, input.player), z: at.z }, direction }
  }

  /** The walkable floor in the column just outside the wall (the player's side), or the player's own standing level. */
  private findFloor(at: Position, direction: Direction, player: string): number {
    const { forward } = HEADINGS[direction]
    const front = { x: at.x - forward.x, z: at.z - forward.z }
    for (let y = at.y + SEARCH_ABOVE; y >= at.y - SEARCH_BELOW; y -= 1)
      if (this.blocks.isSolid({ x: front.x, y: y - 1, z: front.z }) === true) return y
    const standing = this.entities.player(player)?.position
    return standing === undefined ? at.y : Math.floor(standing.y)
  }
}
