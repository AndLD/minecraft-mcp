import type { LookFace } from '../../core/container.port.js'
import type { Position } from '../../core/position.types.js'
import type { SignFacing } from '../../core/sign.port.js'

/** The woods a sign can be made of in 1.21.1 (hanging signs are left out). */
export const SIGN_WOODS = [
  'oak',
  'spruce',
  'birch',
  'jungle',
  'acacia',
  'dark_oak',
  'mangrove',
  'cherry',
  'bamboo',
  'crimson',
  'warped',
] as const

export type SignWood = (typeof SIGN_WOODS)[number]

export const DEFAULT_SIGN_WOOD: SignWood = 'oak'

/** A sign in the world, standing or on a wall. Hanging signs are a different block and are not handled. */
export const isSignBlock = (name: string): boolean =>
  /_(wall_)?sign$/.test(name) && !name.includes('hanging')

/** A sign as an item in the inventory. */
export const isSignItem = (name: string): boolean =>
  name.endsWith('_sign') && !name.includes('hanging')

export const isWallSign = (name: string): boolean => name.endsWith('_wall_sign')

/** `oak` for `oak_sign` and `oak_wall_sign`. */
export const woodOfSign = (name: string): string => name.replace(/_(wall_)?sign$/, '')

export const signItemOf = (wood: string): string => `${wood}_sign`

const FLUIDS = ['water', 'lava', 'bubble_column']
export const isFluid = (name: string): boolean => FLUIDS.some((fluid) => name.includes(fluid))

const AIR = ['air', 'cave_air', 'void_air']
export const isAir = (name: string | undefined): boolean => name !== undefined && AIR.includes(name)

/** Ground the bot must not stand on while working: it would trample the farmland or fall in. */
export const isBadGround = (name: string | undefined): boolean =>
  name === undefined || name === 'farmland' || isFluid(name)

const VECTORS: Readonly<Record<SignFacing, Position>> = {
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
}

export const FACINGS: readonly SignFacing[] = ['north', 'south', 'east', 'west']

export const vectorOf = (facing: SignFacing): Position => VECTORS[facing]

/** The unit vector a face points along, from the block towards the cell in front of that face. */
export const faceVector = (face: LookFace): Position =>
  face === 'top' ? { x: 0, y: 1, z: 0 } : face === 'bottom' ? { x: 0, y: -1, z: 0 } : VECTORS[face]

export const horizontalFace = (face: LookFace): SignFacing | undefined =>
  face === 'top' || face === 'bottom' ? undefined : face

export const offset = (from: Position, by: Position, times = 1): Position => ({
  x: from.x + by.x * times,
  y: from.y + by.y * times,
  z: from.z + by.z * times,
})

/** The compass direction from one point towards another, along the axis that differs most. */
export function facingTowards(from: Position, to: Position): SignFacing {
  const dx = to.x - (from.x + 0.5)
  const dz = to.z - (from.z + 0.5)
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'east' : 'west'
  return dz > 0 ? 'south' : 'north'
}
