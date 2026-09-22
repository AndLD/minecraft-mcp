import type { LookFace, LookTarget } from '../core/container.port.js'
import type { Position } from '../core/position.types.js'
import { EYE_HEIGHT } from '../core/reach.js'
import type { BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

/** How far the player's crosshair reaches. */
const RANGE = 8

/** Mineflayer's `BlockFace` enum (from `prismarine-world`), by its numeric value. */
const FACES: Readonly<Record<number, LookFace>> = {
  0: 'bottom',
  1: 'top',
  2: 'north',
  3: 'south',
  4: 'west',
  5: 'east',
}

export class MineflayerLookTarget implements LookTarget {
  constructor(private readonly holder: BotHolder) {}

  blockLookedAt(
    player: string,
  ): { readonly name: string; readonly position: Position; readonly face: LookFace } | undefined {
    const bot = this.holder.current()
    const wanted = player.toLowerCase()
    const entity = Object.values(bot?.players ?? {}).find(
      (candidate) => candidate.username.toLowerCase() === wanted,
    )?.entity
    if (bot === undefined || entity?.yaw === undefined || entity.pitch === undefined)
      return undefined

    const eyes = { x: entity.position.x, y: entity.position.y + EYE_HEIGHT, z: entity.position.z }
    const direction = {
      x: -Math.sin(entity.yaw) * Math.cos(entity.pitch),
      y: Math.sin(entity.pitch),
      z: -Math.cos(entity.yaw) * Math.cos(entity.pitch),
    }
    const hit = bot.world.raycast(toVec3(eyes), toVec3(direction), RANGE)
    return hit === null
      ? undefined
      : {
          name: hit.name,
          position: { x: hit.position.x, y: hit.position.y, z: hit.position.z },
          face: FACES[hit.face] ?? 'top',
        }
  }
}
