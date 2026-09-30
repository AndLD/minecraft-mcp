import { countItems } from '../../../core/inventory-counts.js'
import type { InventoryReader } from '../../../core/inventory.port.js'
import type { SkillContext, SkillResult } from '../../../core/skill.types.js'
import type { SupplyCrafter } from '../../construction/crafting-supplies.js'
import type { ItemScanner } from '../../storage/scan-containers-skill.js'
import type { WithdrawInput, WithdrawOutput } from '../../storage/withdraw-items-skill.js'

const TORCH = 'torch'
const COAL = 'coal'
const CHARCOAL = 'charcoal'
const STICK = 'stick'
/** The scan also registers unknown containers this close to the bot (the smallest the scan allows). */
const SCAN_RADIUS = 4
/** One coal and one stick make four torches. */
const TORCHES_PER_COAL = 4

export interface Restocked {
  /** Torches the inventory gained (taken from storage, and crafted). */
  readonly torches: number
  /** How many of them were crafted from coal (or charcoal) and sticks taken from storage or carried. */
  readonly crafted: number
}

/** Read through a function so the compiler does not assume the signal is still as it was a moment ago. */
const cancelled = (context: SkillContext): boolean => context.signal.aborted

/** What the cave search needs from a torch supply. */
export interface TorchRestocker {
  /** Torches carried now. */
  carried(): number
  /** Tops the inventory up to `target` torches from storage; never throws, and says what it got. */
  restock(target: number, context: SkillContext): Promise<Restocked>
}

/** Takes items out of containers (the `withdraw_items` skill). */
export interface ItemWithdrawer {
  run(input: WithdrawInput, context: SkillContext): Promise<SkillResult<WithdrawOutput>>
}

export interface TorchSupplyDeps {
  readonly inventory: InventoryReader
  readonly withdraw: ItemWithdrawer
  /** Crafts torches from coal or charcoal and sticks. */
  readonly supplies: SupplyCrafter
  /**
   * Looks into the known containers when memory says none holds torches: a chest that was registered but never
   * opened has no remembered contents. Without it only what memory says is used.
   */
  readonly scanner?: ItemScanner
}

/**
 * Fetches torches for a cave trip from the containers the bot knows: first ready-made torches, then coal or charcoal
 * and sticks to make them. It goes through `withdraw_items`, so protected containers are never opened and the
 * nearest container that holds the item is used first. A container that holds none is simply not used.
 */
export class TorchSupply implements TorchRestocker {
  constructor(private readonly deps: TorchSupplyDeps) {}

  carried(): number {
    return this.count(TORCH)
  }

  async restock(target: number, context: SkillContext): Promise<Restocked> {
    const before = this.carried()
    if (before >= target) return { torches: 0, crafted: 0 }

    context.progress(
      `Fetching torches from storage (${String(before)} carried, ${String(target)} wanted)`,
    )
    await this.take(TORCH, target - before, context)
    if (this.carried() === before && this.deps.scanner !== undefined && !cancelled(context)) {
      // Memory has no torches. A container that was never opened has no remembered contents, so look once.
      context.progress('Looking into the containers for torches')
      await this.deps.scanner.run({ radius: SCAN_RADIUS, refreshKnown: true, skipProtected: true }, context)
      await this.take(TORCH, target - before, context)
    }
    const afterTorches = this.carried()
    const stillNeeded = target - afterTorches
    if (stillNeeded > 0 && !cancelled(context)) await this.craftMissing(stillNeeded, context)
    const after = this.carried()
    return { torches: Math.max(0, after - before), crafted: Math.max(0, after - afterTorches) }
  }

  /** Coal (or charcoal) and sticks from storage, then crafted into torches. */
  private async craftMissing(count: number, context: SkillContext): Promise<void> {
    const crafts = Math.ceil(count / TORCHES_PER_COAL)
    const haveFuel = this.count(COAL) + this.count(CHARCOAL)
    if (haveFuel < crafts) {
      await this.take(COAL, crafts - haveFuel, context)
      const still = crafts - (this.count(COAL) + this.count(CHARCOAL))
      if (still > 0) await this.take(CHARCOAL, still, context)
    }
    if (this.count(COAL) + this.count(CHARCOAL) === 0 || cancelled(context)) return
    // Only as many sticks as the fuel on hand can be used with.
    const usable = Math.min(crafts, this.count(COAL) + this.count(CHARCOAL))
    const haveSticks = this.count(STICK)
    if (haveSticks < usable) await this.take(STICK, usable - haveSticks, context)
    if (cancelled(context)) return
    context.progress(`Crafting ${String(count)} torches`)
    await this.deps.supplies.craft(TORCH, count, context)
  }

  private async take(item: string, count: number, context: SkillContext): Promise<void> {
    await this.deps.withdraw.run({ requests: [{ item, count }], container: undefined }, context)
  }

  private count(item: string): number {
    return countItems(this.deps.inventory.snapshot()).get(item) ?? 0
  }
}
