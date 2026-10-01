/** Blocks worth mentioning when describing surroundings. Data, so it is easy to extend. */
const NOTABLE_PATTERNS: readonly RegExp[] = [
  /_ore$/,
  /^ancient_debris$/,
  /_log$/,
  /^(crafting_table|furnace|blast_furnace|smoker|anvil|enchanting_table|brewing_stand|bookshelf|bell|beacon)$/,
  /(^|_)chest$/,
  /^barrel$/,
  /_bed$/,
  /^(water|lava|spawner|obsidian|nether_portal|hay_block|cactus|sugar_cane|pumpkin|melon)$/,
]

export function isNotableBlock(name: string): boolean {
  return NOTABLE_PATTERNS.some((pattern) => pattern.test(name))
}
