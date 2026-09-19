import { Vec3 } from 'vec3'
import type { Position } from '../core/position.types.js'

/**
 * Mineflayer's world lookups call methods on the position (`floored()`), so a plain `{ x, y, z }` crashes them.
 * Every adapter that hands a position to Mineflayer converts it here.
 */
export const toVec3 = (position: Position): Vec3 => new Vec3(position.x, position.y, position.z)
