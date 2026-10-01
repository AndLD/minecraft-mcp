import type { BlockScanner } from '../../core/block-scanner.port.js'
import { countItems, describeItems, gained } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { InventoryFullKind } from '../../state/storage-policy.js'
import type { CollectBlocksSkill } from '../gathering/collect-blocks-skill.js'
import type { DropCollector } from '../gathering/drop-collector.js'
import { isSaplingName, leavesOf, SAPLING_ITEMS, TREE_NAMES, treeFor } from './tree-table.js'

/** Leaves broken per call to the block collector: small, so the sapling count is looked at often. */
const BATCH = 8
/** Leaves to allow per sapling wanted: about 1 in 20 drops one (1 in 40 for jungle), so this is generous. */
const LEAVES_PER_SAPLING = 40
const MAX_LEAVES = 1000

export interface CollectSaplingsInput {
  /** The tree species (`oak`); any species when left out. */
  readonly species: string | undefined
  /** How many saplings to end up with (gained, not counting what the bot already carried). */
  readonly count: number
  /** Most leaves to break before giving up; 40 per sapling wanted, at most 1000, when left out. */
  readonly maxLeaves: number | undefined
  readonly maxDistance: number
  readonly onInventoryFull?: InventoryFullKind | undefined
}

export interface CollectSaplingsOutput {
  /** Saplings gained. */
  readonly saplings: number
  readonly requested: number
  /** Leaves broken. */
  readonly leaves: number
  /** Everything the inventory gained (sticks and apples come with the leaves). */
  readonly gained: readonly ItemCount[]
}

export interface CollectSaplingsDeps {
  readonly blocks: BlockScanner
  readonly inventory: InventoryReader
  /** Breaks the leaves: protected areas, lava, no tunnelling, and the full-inventory policy all apply. */
  readonly leaves: Pick<CollectBlocksSkill, 'run'>
  readonly drops: DropCollector
}

const detailNumber = (detail: Readonly<Record<string, unknown>> | undefined, key: string): number => {
  const value = detail?.[key]
  return typeof value === 'number' ? value : 0
}

/**
 * Gets saplings by breaking leaves, which drop one by chance, and by picking up the saplings already lying around
 * (leaves that decayed after a tree was felled drop them on the ground). Counted in saplings; the work is a budget
 * of leaves. Leaves are broken with the tool the block collector picks, which is never shears: shears make the leaf
 * block drop itself and no sapling. Only ever run on request: nothing calls this by itself.
 */
export class CollectSaplingsSkill implements Skill<CollectSaplingsInput, CollectSaplingsOutput> {
  readonly name = 'collect_saplings'

  constructor(private readonly deps: CollectSaplingsDeps) {}

  async run(
    input: CollectSaplingsInput,
    context: SkillContext,
  ): Promise<SkillResult<CollectSaplingsOutput>> {
    const spec = input.species === undefined ? undefined : treeFor(input.species)
    if (input.species !== undefined && spec === undefined)
      return err({ reason: 'unknown_species', message: `${input.species} is not a tree with saplings this can collect.` })
    const saplingNames = spec === undefined ? SAPLING_ITEMS : [spec.sapling]
    const wanted = spec === undefined ? undefined : leavesOf(spec)
    const known = this.deps.blocks.knownBlockNames()
    const leafNames =
      wanted === undefined
        ? TREE_NAMES.map((name) => `${name}_leaves`).filter((name) => known.includes(name))
        : [wanted]
    const budget = Math.min(input.maxLeaves ?? LEAVES_PER_SAPLING * input.count, MAX_LEAVES)

    const before = countItems(this.deps.inventory.snapshot())
    const saplingsSince = (): number =>
      gained(before, countItems(this.deps.inventory.snapshot()))
        .filter((item) => isSaplingName(item.name) && saplingNames.includes(item.name))
        .reduce((sum, item) => sum + item.count, 0)
    const summary = (leaves: number) => ({
      saplings: saplingsSince(),
      requested: input.count,
      leaves,
      gained: gained(before, countItems(this.deps.inventory.snapshot())),
    })
    const stop = (reason: string, message: string, leaves: number) => {
      const done = summary(leaves)
      return err({
        reason,
        message: `${message} Got ${String(done.saplings)} of ${String(input.count)} saplings from ${String(leaves)} leaves${
          done.gained.length === 0 ? '' : ` (inventory gained ${describeItems(done.gained)})`
        }.`,
        detail: { saplings: done.saplings, requested: input.count, leaves },
      })
    }

    await this.deps.drops.collect({ names: saplingNames, maxDistance: input.maxDistance }, context.signal)

    let leaves = 0
    while (saplingsSince() < input.count) {
      if (context.signal.aborted) return stop('aborted', 'Cancelled.', leaves)
      if (leaves >= budget)
        return stop(
          'leaf_budget',
          `Broke ${String(leaves)} leaves, the most allowed, and the saplings did not drop.`,
          leaves,
        )
      if (leafNames.length === 0)
        return stop('no_leaves', 'This game has no leaves of that kind.', leaves)

      const ran = await this.deps.leaves.run(
        {
          names: leafNames,
          count: Math.min(BATCH, budget - leaves),
          maxDistance: input.maxDistance,
          onInventoryFull: input.onInventoryFull,
        },
        context,
      )
      if (ran.ok) {
        leaves += ran.value.mined
        if (ran.value.mined === 0) return stop('no_leaves', 'No leaves could be broken.', leaves)
      } else {
        leaves += detailNumber(ran.error.detail, 'mined')
        if (saplingsSince() >= input.count) break
        const reason = ran.error.reason === 'block_not_found' ? 'no_leaves' : ran.error.reason
        return stop(reason, ran.error.message, leaves)
      }
      context.progress(`Saplings ${String(saplingsSince())} of ${String(input.count)} (${String(leaves)} leaves broken)`)
    }
    return ok(summary(leaves))
  }
}
