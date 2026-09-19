import type { Position } from './position.types.js'
import type { Result } from './result.js'

export interface ItemCount {
  readonly name: string
  readonly count: number
}

export interface Recipe {
  /** What is made. */
  readonly result: ItemCount
  /** What is used up, one entry per item name. */
  readonly ingredients: readonly ItemCount[]
  /** True for recipes that need a crafting table (3x3). */
  readonly needsTable: boolean
  /** Position in the list `RecipeBook.recipesFor` returns, so the recipe can be handed back to `Crafter`. */
  readonly index: number
}

export interface RecipeBook {
  /** Every way to make the item. Empty when it cannot be crafted, or when not connected. */
  recipesFor(item: string): readonly Recipe[]
  /** Names of every item that has a crafting recipe. */
  craftableItems(): readonly string[]
  /** True when the game knows an item of this name. */
  isItem(name: string): boolean
}

export interface CraftFailure {
  readonly reason: 'not_connected' | 'unknown_recipe' | 'table_missing' | 'failed'
  readonly message: string
}

export interface Crafter {
  /**
   * Crafts a recipe `times` times from the inventory. Recipes that need a table must name one
   * within reach of the bot.
   */
  craft(
    item: string,
    recipeIndex: number,
    times: number,
    table: Position | undefined,
  ): Promise<Result<void, CraftFailure>>
}
