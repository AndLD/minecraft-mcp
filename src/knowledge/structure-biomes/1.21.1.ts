import type { BiomeRule, VersionedBiomeTable } from './structure-biome-table.types.js'

const OCEANS = [
  'ocean',
  'deep_ocean',
  'cold_ocean',
  'deep_cold_ocean',
  'lukewarm_ocean',
  'deep_lukewarm_ocean',
  'warm_ocean',
  'frozen_ocean',
  'deep_frozen_ocean',
  'mushroom_fields',
]

/** Pillager outposts and villages share most of the flat biomes; outposts also stand in the mountains. */
const VILLAGE: BiomeRule = {
  biomes: ['plains', 'sunflower_plains', 'meadow', 'desert', 'savanna', 'snowy_plains', 'taiga'],
  neighbours: [
    'forest',
    'flower_forest',
    'birch_forest',
    'savanna_plateau',
    'windswept_savanna',
    'snowy_taiga',
    'old_growth_pine_taiga',
    'badlands',
  ],
  never: OCEANS,
}

/** The default table: what is known about Minecraft 1.21.1 (Java). Other versions are merged over it. */
export const TABLE_1_21_1: VersionedBiomeTable = {
  version: '1.21.1',
  rules: {
    village: VILLAGE,
    desert_temple: {
      biomes: ['desert'],
      neighbours: ['savanna', 'plains', 'badlands', 'beach'],
      never: OCEANS,
    },
    jungle_temple: {
      biomes: ['jungle', 'sparse_jungle', 'bamboo_jungle'],
      neighbours: ['plains', 'forest', 'swamp', 'mangrove_swamp', 'beach'],
      never: OCEANS,
    },
    pillager_outpost: {
      biomes: [
        ...VILLAGE.biomes,
        'grove',
        'snowy_slopes',
        'frozen_peaks',
        'jagged_peaks',
        'stony_peaks',
        'cherry_grove',
      ],
      neighbours: VILLAGE.neighbours ?? [],
      never: OCEANS,
    },
    // Mineshafts, ruined portals, dungeons, strongholds, and ancient cities have no useful biome rule from the
    // surface: they use the frontier search.
  },
}
