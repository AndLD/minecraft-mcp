import type { Position } from './position.types.js'

export interface Vitals {
  readonly health: number
  readonly food: number
  /** Hidden food buffer; food only drops once it is used up. */
  readonly saturation: number
  /** Air left while underwater, 0 to 20 (20 is full). */
  readonly oxygen: number
  /** The bot stands in lava. */
  readonly inLava: boolean
  /** Any part of the bot is in water. */
  readonly inWater: boolean
  /** The bot's head is under water (it can drown). */
  readonly headUnderwater: boolean
  readonly position: Position
  readonly dimension: string
  /** Minecraft ticks of the day, 0 to 23999. */
  readonly timeOfDay: number
}

export interface VitalsReader {
  /** Undefined while the bot is not in a world. */
  read(): Vitals | undefined
}
