import type { Position } from './position.types.js'

export interface EntityInfo {
  readonly id: number
  /** Mineflayer's coarse type: `player`, `hostile`, `animal`, `passive`, `object`, `orb`, `other`, ... */
  readonly category: string
  /** For example `zombie`, `cow`, `item`, or the player's name. */
  readonly name: string
  readonly position: Position
  /** Straight-line distance from the bot, in blocks. */
  readonly distance: number
}

export interface PlayerInfo {
  readonly name: string
  /** Listed as online on the server. */
  readonly online: boolean
  /** Undefined when the player is out of the bot's view distance. */
  readonly position: Position | undefined
  readonly distance: number | undefined
  /** Where the player looks, in radians (yaw 0 faces -z, the same convention as `LookTarget`). Undefined when out of view. */
  readonly yaw?: number | undefined
}

export interface EntityScanner {
  /** Every entity type name the game knows (`fox`, `wolf`, ...). Empty while not connected. */
  knownEntityNames(): readonly string[]
  /** Entities within `maxDistance`, nearest first, excluding the bot itself. */
  nearby(maxDistance: number): readonly EntityInfo[]
  /** Case-insensitive lookup. Undefined when no such player is online. */
  player(name: string): PlayerInfo | undefined
}
