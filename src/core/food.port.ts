import type { Result } from './result.js'

export interface FoodInfo {
  readonly name: string
  /** Hunger points restored (each is half a drumstick). */
  readonly foodPoints: number
  readonly saturation: number
}

export interface FoodCatalog {
  /** Undefined for items that are not food. */
  info(item: string): FoodInfo | undefined
}

export interface Eater {
  /** Takes the item in hand and eats it. Takes about 1.6 seconds. */
  eat(item: string): Promise<Result<void>>
}
