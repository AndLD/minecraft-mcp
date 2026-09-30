/** What a fishing rod brings up: fish, treasure, and junk (everything else). Names are the 1.21 item names. */
export const FISH = new Set(['cod', 'salmon', 'pufferfish', 'tropical_fish'])
export const TREASURE = new Set(['name_tag', 'saddle', 'nautilus_shell', 'enchanted_book', 'bow'])

export type CatchKind = 'fish' | 'treasure' | 'junk'

export function kindOfCatch(item: string): CatchKind {
  if (FISH.has(item)) return 'fish'
  if (TREASURE.has(item)) return 'treasure'
  return 'junk'
}
