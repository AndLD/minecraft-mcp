import type { InventoryReader } from '../../core/inventory.port.js'
import { countItems } from '../../core/inventory-counts.js'
import type { ItemCount } from '../../core/recipes.port.js'
import type { SkillContext, SkillResult } from '../../core/skill.types.js'
import type { ItemWithdrawer } from '../handover/give-items-skill.js'
import type { ItemScanner } from '../storage/scan-containers-skill.js'

/** Brings missing building materials into the inventory. */
export interface MaterialFetcher {
  /** `missing` is how many MORE of each item the inventory needs (what a preview reports). */
  fetch(missing: readonly ItemCount[], context: SkillContext): Promise<void>
}

export interface StorageMaterialFetcherDeps {
  readonly inventory: InventoryReader
  readonly withdrawer: ItemWithdrawer
  readonly scanner: ItemScanner
}

/**
 * Fetches materials from the chests the bot may use: first what the container memory knows, then, when that is not
 * enough, after looking into the containers nobody has opened yet. Whatever it cannot find stays missing; the caller
 * reports it.
 */
export class StorageMaterialFetcher implements MaterialFetcher {
  constructor(private readonly deps: StorageMaterialFetcherDeps) {}

  async fetch(missing: readonly ItemCount[], context: SkillContext): Promise<void> {
    const { deps } = this
    // What the inventory must hold in the end: what it holds now plus what is missing.
    const start = countItems(deps.inventory.snapshot())
    const short = (): { item: string; count: number }[] => {
      const carried = countItems(deps.inventory.snapshot())
      return missing
        .map((m) => ({
          item: m.name,
          count: (start.get(m.name) ?? 0) + m.count - (carried.get(m.name) ?? 0),
        }))
        .filter((m) => m.count > 0)
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requests = short()
      if (requests.length === 0 || context.signal.aborted) return
      if (attempt === 0) context.progress('Fetching materials from the containers')
      else {
        context.progress('Not enough in the known containers: looking into the others')
        const scanned: SkillResult<unknown> = await deps.scanner.run(
          { radius: 24, refreshKnown: true },
          context,
        )
        if (!scanned.ok && scanned.error.reason === 'aborted') return
      }
      const result = await deps.withdrawer.run({ requests, container: undefined }, context)
      if (!result.ok && result.error.reason === 'aborted') return
    }
  }
}
