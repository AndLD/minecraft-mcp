import type { Position } from './position.types.js'

/** An animal the bot can see, with what decides whether it may be hunted. */
export interface AnimalInfo {
  readonly id: number
  /** Entity name, for example `cow`. */
  readonly species: string
  readonly position: Position
  /** Straight-line distance from the bot, in blocks. */
  readonly distance: number
  readonly baby: boolean
  /** Has a custom name (a name tag): somebody's pet or favorite. */
  readonly named: boolean
  /** Has an owner: a tamed animal. */
  readonly owned: boolean
  readonly saddled: boolean
  /** Somebody is riding it. */
  readonly ridden: boolean
  /** Dead, and still lingering for its death animation. */
  readonly dead: boolean
}

export interface AnimalScanner {
  /** Living animals within `maxDistance`, nearest first. */
  nearby(maxDistance: number): readonly AnimalInfo[]
  /** One animal by entity id, dead ones included; undefined once it is gone from the world. */
  find(id: number): AnimalInfo | undefined
}
