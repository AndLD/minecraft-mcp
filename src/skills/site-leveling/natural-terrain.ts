/**
 * Plain, unworked ground: ordinary stone, dirt, sand, and the like. Cutting or clearing these needs no player's
 * permission; anything else found on a plot (a wall, a fence, a door, a chest, ...) is left alone by default.
 */
const NATURAL_BLOCKS = new Set([
  'dirt',
  'coarse_dirt',
  'rooted_dirt',
  'podzol',
  'mycelium',
  'grass_block',
  'stone',
  'granite',
  'diorite',
  'andesite',
  'deepslate',
  'tuff',
  'calcite',
  'sandstone',
  'red_sandstone',
  'sand',
  'red_sand',
  'gravel',
  'clay',
  'netherrack',
  'soul_sand',
  'soul_soil',
  'basalt',
  'blackstone',
  'end_stone',
  'moss_block',
  'snow',
  'snow_block',
  'ice',
  'packed_ice',
  'blue_ice',
])

/** Ore, and the deepslate variants a cut through rock naturally turns up. */
const ORE = /(_ore|ancient_debris)$/

/** Whatever grows on its own and is fine to clear without asking: grass, flowers, dead growth, vines, mushrooms. */
const VEGETATION = new Set([
  'short_grass',
  'tall_grass',
  'fern',
  'large_fern',
  'dead_bush',
  'vine',
  'lily_pad',
  'seagrass',
  'tall_seagrass',
  'kelp',
  'kelp_plant',
  'sugar_cane',
  'bamboo',
  'cactus',
  'mushroom_stem',
  'brown_mushroom',
  'red_mushroom',
  'brown_mushroom_block',
  'red_mushroom_block',
])
const FLOWER =
  /_(flower|tulip|orchid)$|^(dandelion|poppy|sunflower|lilac|rose_bush|peony|allium|blue_orchid|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|torchflower|pitcher_plant)$/
const SAPLING = /_sapling$/

/** Logs and leaves: cleared only when `clear_trees` is on, so a tree is not felled by accident. */
const LOG = /^(stripped_)?[a-z]+_(log|wood)$/
const LEAVES = /_leaves$/

export function isNaturalTerrain(name: string): boolean {
  return NATURAL_BLOCKS.has(name) || ORE.test(name)
}

export function isVegetation(name: string): boolean {
  return VEGETATION.has(name) || FLOWER.test(name) || SAPLING.test(name)
}

export function isTreePart(name: string): boolean {
  return LOG.test(name) || LEAVES.test(name)
}

/**
 * Whether a block above the target level is cleared without the player's say-so: natural stone and soil, whatever
 * grows on its own, and — only when `clearTrees` is allowed — logs and leaves. Anything else (a wall, a fence, a
 * door, a chest, a lit torch someone placed) is left alone: it is reported as blocked, not broken.
 */
export function isClearable(name: string, clearTrees: boolean): boolean {
  if (isNaturalTerrain(name) || isVegetation(name)) return true
  return clearTrees && isTreePart(name)
}

/**
 * What cutting the ground actually drops, worth reusing as fill: cobblestone and sand drop themselves or a close
 * cousin, so a cut plot needs little or nothing fetched. Picked from what a cut gained, biggest pile first.
 */
export const FILL_CANDIDATES = new Set([
  'dirt',
  'cobblestone',
  'cobbled_deepslate',
  'sand',
  'red_sand',
  'gravel',
  'netherrack',
  'sandstone',
])

/** The best block to fill with from what a cut gained (biggest pile first, already sorted); `dirt` otherwise. */
export function pickFillBlock(
  gained: readonly { readonly name: string; readonly count: number }[],
): string {
  return gained.find((item) => FILL_CANDIDATES.has(item.name))?.name ?? 'dirt'
}
