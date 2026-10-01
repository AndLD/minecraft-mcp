import { countItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { ItemCount } from '../../core/recipes.port.js'
import type { SkillContext } from '../../core/skill.types.js'
import type { ItemWithdrawer } from '../discovery/caves/torch-supply.js'
import type { ItemScanner } from '../storage/scan-containers-skill.js'
import { itemsPerUnit } from './fuel.js'

/** Fuels taken from storage when none is named: the ones meant for it, cheapest first. Blocks and rods are never taken. */
const STORAGE_FUELS = ['charcoal', 'coal'] as const
/** The scan also registers unknown containers this close to the bot (the smallest the scan allows). */
const SCAN_RADIUS = 4

/** What smelting needs from a fuel supply: more fuel into the bag for `items` more items. */
export interface FuelFetcher {
  /** Takes fuel that smelts `items` items out of storage; returns what came into the bag (nothing when none was found). */
  fetch(
    items: number,
    preferred: string | undefined,
    context: SkillContext,
    /** How much faster than a furnace the station smelts (2 for a blast furnace or a smoker). */
    speed?: number,
  ): Promise<ItemCount[]>
}

export interface FuelSupplyDeps {
  readonly inventory: InventoryReader
  readonly withdraw: ItemWithdrawer
  /**
   * Looks into the known containers when memory says none holds the fuel: a chest that was registered but never
   * opened has no remembered contents. Without it only what memory says is used.
   */
  readonly scanner?: ItemScanner
}

/**
 * Fetches fuel for a smelting job from the containers the bot knows, through `withdraw_items` (so protected
 * containers are never opened and the nearest container that holds the fuel is used first). Charcoal and coal unless
 * a fuel is named; a fuel that is named is the only one taken. It fetches only what the job lacks.
 */
export class FuelSupply implements FuelFetcher {
  constructor(private readonly deps: FuelSupplyDeps) {}

  async fetch(
    items: number,
    preferred: string | undefined,
    context: SkillContext,
    speed = 1,
  ): Promise<ItemCount[]> {
    const before = countItems(this.deps.inventory.snapshot())
    let missing = items
    let scanned = false
    for (const kind of preferred === undefined ? STORAGE_FUELS : [preferred]) {
      const base = itemsPerUnit(kind)
      const per = base === undefined ? undefined : base * speed
      if (per === undefined || missing <= 0 || cancelled(context)) continue
      const units = Math.ceil(missing / per)
      let got = await this.take(kind, units, context)
      if (got === 0 && !scanned && this.deps.scanner !== undefined && !cancelled(context)) {
        scanned = true
        context.progress('Looking into the containers for fuel')
        await this.deps.scanner.run(
          { radius: SCAN_RADIUS, refreshKnown: true, skipProtected: true },
          context,
        )
        got = await this.take(kind, units, context)
      }
      missing -= got * per
    }
    const after = countItems(this.deps.inventory.snapshot())
    return [...after]
      .map(([name, count]) => ({ name, count: count - (before.get(name) ?? 0) }))
      .filter(
        (entry) =>
          entry.count > 0 &&
          (preferred === undefined
            ? STORAGE_FUELS.some((kind) => kind === entry.name)
            : entry.name === preferred),
      )
  }

  /** How many of the item came into the bag. */
  private async take(item: string, count: number, context: SkillContext): Promise<number> {
    const before = countItems(this.deps.inventory.snapshot()).get(item) ?? 0
    await this.deps.withdraw.run({ requests: [{ item, count }], container: undefined }, context)
    return Math.max(0, (countItems(this.deps.inventory.snapshot()).get(item) ?? 0) - before)
  }
}

/** Read through a function so the compiler does not assume the signal is still as it was a moment ago. */
const cancelled = (context: SkillContext): boolean => context.signal.aborted
