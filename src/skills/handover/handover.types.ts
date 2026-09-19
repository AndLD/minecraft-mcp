/** How much of an item was asked for. */
export type Amount =
  | { readonly kind: 'count'; readonly count: number }
  | { readonly kind: 'stacks'; readonly stacks: number }
  /** Everything the bot has (carried, and stored when fetching is allowed). */
  | { readonly kind: 'all' }

export interface ItemRequest {
  /** What the player said: an item name, a plural, an everyday word ("cobble"), or a group ("logs", "food"). */
  readonly item: string
  readonly amount: Amount
}
