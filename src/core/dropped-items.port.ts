import type { Position } from './position.types.js'

export interface DroppedItem {
  readonly entityId: number
  /** Item name, for example `oak_log`. */
  readonly name: string
  readonly count: number
  readonly position: Position
  /** Straight-line distance from the bot, in blocks. */
  readonly distance: number
}

export interface DroppedItemScanner {
  /** Items lying on the ground within `maxDistance` of the bot, nearest first. */
  nearby(maxDistance: number): readonly DroppedItem[]
}
