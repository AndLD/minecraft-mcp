/** What a furnace turns each item into. Minecraft data has no smelting recipes, so this is our own table. */
export const SMELTING_TABLE: Readonly<Record<string, string>> = {
  // ores and metals
  raw_iron: 'iron_ingot',
  raw_gold: 'gold_ingot',
  raw_copper: 'copper_ingot',
  iron_ore: 'iron_ingot',
  deepslate_iron_ore: 'iron_ingot',
  gold_ore: 'gold_ingot',
  deepslate_gold_ore: 'gold_ingot',
  copper_ore: 'copper_ingot',
  deepslate_copper_ore: 'copper_ingot',
  ancient_debris: 'netherite_scrap',
  // stone and building materials
  cobblestone: 'stone',
  stone: 'smooth_stone',
  cobbled_deepslate: 'deepslate',
  sand: 'glass',
  red_sand: 'glass',
  clay_ball: 'brick',
  clay: 'terracotta',
  netherrack: 'nether_brick',
  quartz_block: 'smooth_quartz',
  sandstone: 'smooth_sandstone',
  wet_sponge: 'sponge',
  // wood, plants
  oak_log: 'charcoal',
  spruce_log: 'charcoal',
  birch_log: 'charcoal',
  jungle_log: 'charcoal',
  acacia_log: 'charcoal',
  dark_oak_log: 'charcoal',
  cherry_log: 'charcoal',
  mangrove_log: 'charcoal',
  cactus: 'green_dye',
  kelp: 'dried_kelp',
  chorus_fruit: 'popped_chorus_fruit',
  // food
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  mutton: 'cooked_mutton',
  chicken: 'cooked_chicken',
  rabbit: 'cooked_rabbit',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato',
}

export const SMELTABLE_ITEMS = Object.keys(SMELTING_TABLE)
