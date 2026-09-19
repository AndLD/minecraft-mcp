/** What the game data says about items, for rules that depend on it (food, blocks, stack sizes). */
export interface ItemFacts {
  /** True when the game knows an item of this name. */
  isItem(name: string): boolean
  isFood(name: string): boolean
  /** True for items that place a block. */
  isBlock(name: string): boolean
  stackSize(name: string): number
}
