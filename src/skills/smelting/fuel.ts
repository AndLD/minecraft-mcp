import type { ItemCount } from '../../core/recipes.port.js'

/** How many items one unit of the fuel smelts (a furnace burns 200 ticks per item). */
export function itemsPerUnit(item: string): number | undefined {
  const fixed: Readonly<Record<string, number>> = {
    coal: 8,
    charcoal: 8,
    coal_block: 80,
    blaze_rod: 12,
    lava_bucket: 100,
    dried_kelp_block: 20,
    stick: 0.5,
    bamboo: 0.25,
  }
  if (fixed[item] !== undefined) return fixed[item]
  if (item.endsWith('_planks') || item.endsWith('_log') || item.endsWith('_wood')) return 1.5
  return undefined
}

/**
 * Fuels used when the caller does not name one, cheapest and least useful first. Coal blocks, blaze rods, and lava
 * buckets are valuable, so they are only burned when asked for by name.
 */
const DEFAULT_ORDER: readonly ((item: string) => boolean)[] = [
  (item) => item === 'charcoal',
  (item) => item === 'coal',
  (item) => item === 'stick',
  (item) => item.endsWith('_planks'),
  (item) => item.endsWith('_log') || item.endsWith('_wood'),
]

export interface FuelChoice {
  readonly item: string
  /** How many to put in the furnace. */
  readonly amount: number
  /** How many items that much fuel can smelt. */
  readonly capacity: number
}

/**
 * How many items all the usable fuel in the inventory can smelt together (the fuels are burned one after the other
 * as the job goes on). `preferred` narrows it to one fuel. `reserved` is what the smelting itself uses up.
 */
export function totalFuelCapacity(options: {
  readonly inventory: ReadonlyMap<string, number>
  readonly reserved?: ItemCount | undefined
  readonly preferred?: string | undefined
}): number {
  const candidates =
    options.preferred === undefined
      ? DEFAULT_ORDER.flatMap((matches) => [...options.inventory.keys()].filter(matches))
      : [options.preferred]
  let total = 0
  for (const item of new Set(candidates)) {
    const per = itemsPerUnit(item)
    const have =
      (options.inventory.get(item) ?? 0) -
      (options.reserved?.name === item ? options.reserved.count : 0)
    if (per !== undefined && have > 0) total += Math.floor(have * per)
  }
  return total
}

/**
 * Picks a fuel for smelting `toSmelt` items. Prefers one that covers everything (with the fewest units); when none
 * does, takes the one that smelts the most. Undefined when the inventory holds no usable fuel.
 * `reserved` is what the smelting itself uses up, so logs are not burned while being turned into charcoal.
 */
export function chooseFuel(options: {
  readonly inventory: ReadonlyMap<string, number>
  readonly toSmelt: number
  readonly reserved?: ItemCount | undefined
  readonly preferred?: string | undefined
}): FuelChoice | undefined {
  const available = (item: string): number =>
    (options.inventory.get(item) ?? 0) -
    (options.reserved?.name === item ? options.reserved.count : 0)

  const candidates =
    options.preferred === undefined
      ? DEFAULT_ORDER.flatMap((matches) => [...options.inventory.keys()].filter(matches).sort())
      : [options.preferred]

  const usable: FuelChoice[] = []
  for (const item of candidates) {
    const per = itemsPerUnit(item)
    const have = available(item)
    if (per === undefined || have <= 0) continue
    const amount = Math.min(Math.ceil(options.toSmelt / per), have)
    const capacity = Math.floor(amount * per)
    if (capacity > 0) usable.push({ item, amount, capacity })
  }
  const covering = usable.find((choice) => choice.capacity >= options.toSmelt)
  if (covering !== undefined) return covering
  return [...usable].sort((a, b) => b.capacity - a.capacity)[0]
}
