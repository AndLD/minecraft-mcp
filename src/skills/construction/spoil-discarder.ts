import { countItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import type { SkillContext } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { ItemThrower } from '../handover/item-thrower.js'

/** What a quarry mostly digs up and nobody wants more of. */
export const JUNK = [
  'cobblestone',
  'dirt',
  'gravel',
  'sand',
  'andesite',
  'diorite',
  'granite',
  'tuff',
  'deepslate',
  'cobbled_deepslate',
  'netherrack',
  'stone',
  'grass_block',
  'coarse_dirt',
  'rooted_dirt',
  'calcite',
  'dripstone_block',
] as const

/** Enough of each kind to build with; the rest is thrown away. */
const STOCK = 64

export interface SpoilDiscarderDeps {
  readonly inventory: InventoryReader
  readonly thrower: ItemThrower
  readonly vitals: VitalsReader
  /** Told what was thrown and where, so nothing picks it up again. */
  readonly ignore: { add(items: readonly ItemCount[], position: Position): void }
}

/**
 * Throws away the spoil of a dig (cobblestone, dirt, gravel, deepslate, ...) beyond a small stock, where the bot
 * stands, so a big quarry never has to stop for a full inventory. What it threw is remembered, so the drop collector
 * leaves it lying. Never touches anything that is not on the junk list (ores, tools, food, torches, ladders).
 */
export class SpoilDiscarder {
  constructor(private readonly deps: SpoilDiscarderDeps) {}

  /** Throws the excess junk out. Returns how many items it got rid of. */
  async discard(context: SkillContext): Promise<number> {
    const { deps } = this
    const carried = countItems(deps.inventory.snapshot())
    const excess: ItemCount[] = []
    for (const name of JUNK) {
      const extra = (carried.get(name) ?? 0) - STOCK
      if (extra > 0) excess.push({ name, count: extra })
    }
    if (excess.length === 0) return 0
    const here = deps.vitals.read()?.position
    context.progress('Throwing away spoil to make room')
    const thrown = await deps.thrower.throwAll(excess, context.signal)
    if (here !== undefined) deps.ignore.add(thrown, here)
    return thrown.reduce((sum, item) => sum + item.count, 0)
  }
}
