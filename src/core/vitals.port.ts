import type { Position } from './position.types.js'

export interface Vitals {
  readonly health: number
  readonly food: number
  readonly position: Position
  readonly dimension: string
  /** Minecraft ticks of the day, 0 to 23999. */
  readonly timeOfDay: number
}

export interface VitalsReader {
  /** Undefined while the bot is not in a world. */
  read(): Vitals | undefined
}
