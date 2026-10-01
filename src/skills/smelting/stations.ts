import { SMELTING_TABLE } from './smelting-table.js'

/** The three blocks that smelt: the furnace does everything, the other two do less, twice as fast. */
export const STATION_NAMES = ['furnace', 'blast_furnace', 'smoker'] as const
export type Station = (typeof STATION_NAMES)[number]

export interface StationSpec {
  /** The block the bot needs. */
  readonly block: Station
  /** Time to smelt one item. The fuel burns at the same rate, so the same fuel smelts `speed` times as many. */
  readonly msPerItem: number
  readonly speed: number
}

export const STATIONS: Readonly<Record<Station, StationSpec>> = {
  furnace: { block: 'furnace', msPerItem: 10_000, speed: 1 },
  blast_furnace: { block: 'blast_furnace', msPerItem: 5_000, speed: 2 },
  smoker: { block: 'smoker', msPerItem: 5_000, speed: 2 },
}

/** What a blast furnace smelts: ores and raw metals (not the stone, glass, food, or charcoal a furnace makes). */
const BLAST_FURNACE_ITEMS: ReadonlySet<string> = new Set([
  'raw_iron',
  'raw_gold',
  'raw_copper',
  'iron_ore',
  'deepslate_iron_ore',
  'gold_ore',
  'deepslate_gold_ore',
  'copper_ore',
  'deepslate_copper_ore',
  'ancient_debris',
])

/** What a smoker cooks: food, and the kelp that is dried in one. */
const SMOKER_ITEMS: ReadonlySet<string> = new Set([
  'beef',
  'porkchop',
  'mutton',
  'chicken',
  'rabbit',
  'cod',
  'salmon',
  'potato',
  'kelp',
])

/** Whether a station can smelt the item. A furnace smelts everything in the smelting table. */
export function stationSmelts(station: Station, item: string): boolean {
  if (SMELTING_TABLE[item] === undefined) return false
  if (station === 'blast_furnace') return BLAST_FURNACE_ITEMS.has(item)
  if (station === 'smoker') return SMOKER_ITEMS.has(item)
  return true
}

/** The stations that could smelt the item, the specialised (faster) ones first. */
export function stationsFor(item: string): Station[] {
  return (['blast_furnace', 'smoker', 'furnace'] as const).filter((station) =>
    stationSmelts(station, item),
  )
}

/** The campfire cooks without a window and without fuel: the food goes on the block and pops out when it is done. */
export const CAMPFIRE = 'campfire'
/** The block names that count as the campfire station (a soul campfire cooks the same way). */
export const CAMPFIRE_BLOCKS = ['campfire', 'soul_campfire'] as const
/** A campfire holds four items, each cooks for 30 seconds. */
export const CAMPFIRE_SLOTS = 4
export const CAMPFIRE_MS_PER_ITEM = 30_000

/** Every block that can smelt or cook: the three station blocks and the campfire. */
export type AnyStation = Station | typeof CAMPFIRE

/** What a campfire cooks: raw food. Not kelp (only a smoker or a furnace dries it), and nothing that is not food. */
const CAMPFIRE_ITEMS: ReadonlySet<string> = new Set([
  'beef',
  'porkchop',
  'mutton',
  'chicken',
  'rabbit',
  'cod',
  'salmon',
  'potato',
])

export function campfireCooks(item: string): boolean {
  return CAMPFIRE_ITEMS.has(item) && SMELTING_TABLE[item] !== undefined
}
