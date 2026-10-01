import type { Liquid } from '../../core/bucket.port.js'

export const EMPTY_BUCKET = 'bucket'

export const filledBucketOf = (liquid: Liquid): string => `${liquid}_bucket`

/** What to tell the agent when no empty bucket is carried: the bot never crafts one on its own here. */
export const NO_BUCKET_MESSAGE =
  'The bot has no empty bucket. Craft one first (craft item "bucket": 3 iron ingots), then try again.'

/**
 * Things people make, found next to a lava pool: a wall, a floor, a door, a chest, a light. Lava is often part of a
 * build (a lava farm, a trap, a lit pit), so taking a source from beside one needs the player to name the block.
 * Natural stone, obsidian, netherrack, and the like are not on the list: they are what lava lies in.
 */
const PLAYER_BUILT =
  /(_planks|_stairs|_slab|_fence|_fence_gate|_wall|_door|_trapdoor|_button|_pressure_plate|_sign|_hanging_sign|_bed|_wool|_carpet|_concrete|_glazed_terracotta|_terracotta|_stained_glass|_stained_glass_pane|_shulker_box|_banner)$|(^|_)(bricks?|glass|glass_pane)$|^(chest|trapped_chest|barrel|furnace|blast_furnace|smoker|crafting_table|torch|wall_torch|soul_torch|lantern|soul_lantern|ladder|lever|rail|powered_rail|detector_rail|activator_rail|hopper|dispenser|dropper|piston|sticky_piston|observer|redstone_wire|repeater|comparator|redstone_torch|redstone_lamp|bookshelf|iron_bars|scaffolding|anvil|enchanting_table|brewing_stand|cauldron|composter|campfire|jukebox|note_block|tnt)$/

export const isPlayerBuilt = (name: string): boolean => PLAYER_BUILT.test(name)

/** How far from a lava source a player-built block still makes the source off limits (unless the player named it). */
export const STRUCTURE_RADIUS = 4
