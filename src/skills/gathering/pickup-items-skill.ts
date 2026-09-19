import { countItems, gained } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { DropCollector } from './drop-collector.js'

export interface PickupInput {
  /** Only these items; all items when empty. */
  readonly names: readonly string[]
  readonly maxDistance: number
}

export interface PickupOutput {
  readonly picked: readonly ItemCount[]
  /** Stacks still lying within range (unreachable, or the inventory was full). */
  readonly remaining: number
}

/** Walks onto items lying on the ground so the game picks them up. */
export class PickupItemsSkill implements Skill<PickupInput, PickupOutput> {
  readonly name = 'pickup_items'

  constructor(
    private readonly collector: DropCollector,
    private readonly inventory: InventoryReader,
  ) {}

  async run(input: PickupInput, context: SkillContext): Promise<SkillResult<PickupOutput>> {
    const filter = { names: input.names, maxDistance: input.maxDistance }
    const wanted = this.collector.matching(filter)
    if (wanted.length === 0)
      return err({
        reason: 'no_items_nearby',
        message: `No ${input.names.length === 0 ? 'dropped items' : input.names.join(', ')} within ${String(input.maxDistance)} blocks.`,
      })

    const before = countItems(this.inventory.snapshot())
    context.progress(`Picking up ${String(wanted.length)} item stack(s)`)
    await this.collector.collect(filter, context.signal)
    if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })

    const picked = gained(before, countItems(this.inventory.snapshot()))
    const remaining = this.collector.matching(filter).length
    if (picked.length === 0) {
      const full = this.inventory.snapshot()?.emptySlots === 0
      return err({
        reason: full ? 'inventory_full' : 'pickup_failed',
        message: full
          ? 'The inventory is full, so nothing could be picked up.'
          : 'Could not reach the items to pick them up.',
      })
    }
    return ok({ picked, remaining })
  }
}
