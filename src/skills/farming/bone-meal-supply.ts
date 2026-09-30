import { countItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { SkillContext } from '../../core/skill.types.js'
import type { ItemCrafter } from '../crafting/craft-item-skill.js'
import type { ItemWithdrawer } from '../discovery/caves/torch-supply.js'
import type { ItemScanner } from '../storage/scan-containers-skill.js'

const BONE_MEAL = 'bone_meal'
const BONE = 'bone'
/** One bone makes three bone meal. */
const MEAL_PER_BONE = 3
/** The scan also registers unknown containers this close to the bot (the smallest the scan allows). */
const SCAN_RADIUS = 4

export interface BoneMealSources {
  /** Take bone meal (and bones, when crafting) out of registered, unprotected containers. */
  readonly fromStorage: boolean
  /** Craft bones from the bag (or storage) into bone meal. */
  readonly craft: boolean
}

export interface BoneMealOutcome {
  /** Bone meal carried after the top-up. */
  readonly have: number
  readonly fetched: number
  readonly crafted: number
}

/** What fertilizing needs from a bone meal supply. */
export interface BoneMealSupplier {
  /** Brings the bag up to `wanted` bone meal from the allowed sources; never throws, and says what it got. */
  ensure(wanted: number, sources: BoneMealSources, context: SkillContext): Promise<BoneMealOutcome>
}

export interface BoneMealSupplyDeps {
  readonly inventory: InventoryReader
  readonly withdraw: ItemWithdrawer
  readonly crafter: ItemCrafter
  /** Looks into never-opened registered containers once when memory says none holds what is needed. */
  readonly scanner?: ItemScanner
}

const carried = (inventory: InventoryReader, item: string): number =>
  countItems(inventory.snapshot()).get(item) ?? 0

/** Read through a function so the compiler does not assume the signal is still as it was a moment ago. */
const cancelled = (context: SkillContext): boolean => context.signal.aborted

/**
 * Gets bone meal into the bag: what is carried first, then storage (through `withdraw_items`, which never opens a
 * protected container), then crafting from bones. It never breaks skeleton bones or hunts for them.
 */
export class BoneMealSupply implements BoneMealSupplier {
  constructor(private readonly deps: BoneMealSupplyDeps) {}

  async ensure(
    wanted: number,
    sources: BoneMealSources,
    context: SkillContext,
  ): Promise<BoneMealOutcome> {
    const start = carried(this.deps.inventory, BONE_MEAL)
    let fetched = 0
    let crafted = 0
    if (start < wanted && sources.fromStorage && !cancelled(context)) {
      fetched += await this.fromStorage(BONE_MEAL, wanted - start, context)
    }
    if (carried(this.deps.inventory, BONE_MEAL) < wanted && sources.craft && !cancelled(context)) {
      const missing = wanted - carried(this.deps.inventory, BONE_MEAL)
      const bonesNeeded = Math.ceil(missing / MEAL_PER_BONE)
      if (carried(this.deps.inventory, BONE) < bonesNeeded && sources.fromStorage)
        await this.fromStorage(BONE, bonesNeeded - carried(this.deps.inventory, BONE), context)
      const bones = Math.min(bonesNeeded, carried(this.deps.inventory, BONE))
      if (bones > 0 && !cancelled(context)) {
        const before = carried(this.deps.inventory, BONE_MEAL)
        await this.deps.crafter.run({ item: BONE_MEAL, count: bones * MEAL_PER_BONE }, context)
        crafted = Math.max(0, carried(this.deps.inventory, BONE_MEAL) - before)
      }
    }
    return { have: carried(this.deps.inventory, BONE_MEAL), fetched, crafted }
  }

  /** How many of the item came into the bag from containers. */
  private async fromStorage(item: string, count: number, context: SkillContext): Promise<number> {
    const before = carried(this.deps.inventory, item)
    await this.deps.withdraw.run({ requests: [{ item, count }], container: undefined }, context)
    if (
      carried(this.deps.inventory, item) === before &&
      this.deps.scanner !== undefined &&
      !cancelled(context)
    ) {
      context.progress(`Looking into the containers for ${item}`)
      await this.deps.scanner.run(
        { radius: SCAN_RADIUS, refreshKnown: true, skipProtected: true },
        context,
      )
      await this.deps.withdraw.run({ requests: [{ item, count }], container: undefined }, context)
    }
    return Math.max(0, carried(this.deps.inventory, item) - before)
  }
}
