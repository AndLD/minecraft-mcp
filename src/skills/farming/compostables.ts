/** The chance (percent) that one of the item raises a composter's level, by the game's own table. */
const FIXED: Readonly<Record<string, number>> = {
  dried_kelp: 30,
  kelp: 30,
  short_grass: 30,
  fern: 30,
  sweet_berries: 30,
  glow_berries: 30,
  wheat_seeds: 30,
  beetroot_seeds: 30,
  melon_seeds: 30,
  pumpkin_seeds: 30,
  torchflower_seeds: 30,
  pitcher_pod: 30,
  cactus: 50,
  sugar_cane: 50,
  melon_slice: 50,
  vine: 50,
  apple: 65,
  beetroot: 65,
  carrot: 65,
  potato: 65,
  wheat: 65,
  melon: 65,
  pumpkin: 65,
  brown_mushroom: 65,
  red_mushroom: 65,
  bread: 85,
  baked_potato: 85,
  hay_block: 85,
  cookie: 85,
  pumpkin_pie: 100,
  cake: 100,
}

/** The chance (percent) an item composts, or undefined when it is not compostable. */
export function compostChance(item: string): number | undefined {
  if (FIXED[item] !== undefined) return FIXED[item]
  if (item.endsWith('_sapling') || item.endsWith('_leaves')) return 30
  return undefined
}

/**
 * Scraps the bot composts when the player names no items: seeds, saplings, leaves, grass, and kelp. Food, crops, and
 * tools are never on this list; a named item is used as given.
 */
export function isScrap(item: string): boolean {
  return (
    item.endsWith('_seeds') ||
    item === 'pitcher_pod' ||
    item.endsWith('_sapling') ||
    item.endsWith('_leaves') ||
    item === 'short_grass' ||
    item === 'fern' ||
    item === 'kelp'
  )
}
