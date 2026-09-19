import type { AreaGuard } from '../../core/area-guard.port.js'
import type { BlockInfo, BlockScanner } from '../../core/block-scanner.port.js'
import type { Digger } from '../../core/digger.port.js'
import { countItems, describeItems, gained } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { BlockFinder } from '../../perception/block-finder.js'
import { expandBlockNames } from './block-aliases.js'
import type { DropCollector } from './drop-collector.js'

/** Walk to within this many blocks of a block before digging (dig reach is 4.5 from the eyes). */
const APPROACH_RANGE = 3
const CLOSE_RANGE = 1.5
const CANDIDATES = 32
/** Give up after this many blocks in a row could not be reached or dug. */
const MAX_CONSECUTIVE_SKIPS = 6

const NEIGHBOURS: readonly Position[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
]

export interface CollectInput {
  /** Block names, or a group such as `logs`. */
  readonly names: readonly string[]
  /** How many blocks to break. */
  readonly count: number
  readonly maxDistance: number
  /** Called after every block, so a caller can track what is left. */
  readonly onMined?: (mined: number) => void
}

export interface CollectOutput {
  readonly mined: number
  readonly requested: number
  /** What the inventory gained meanwhile (drops differ from the blocks: stone drops cobblestone). */
  readonly gained: readonly ItemCount[]
}

export interface CollectBlocksDeps {
  readonly blocks: BlockScanner
  readonly finder: BlockFinder
  readonly digger: Digger
  readonly navigator: Navigator
  readonly inventory: InventoryReader
  readonly vitals: VitalsReader
  readonly drops: DropCollector
  readonly guard: AreaGuard
}

const keyOf = (position: Position): string =>
  `${String(position.x)},${String(position.y)},${String(position.z)}`

/**
 * Breaks blocks of the given types, nearest first, and picks up what they drop. Only blocks that touch open space
 * are dug (the bot never tunnels to reach one), never the block underfoot, never next to lava, and never inside a
 * protected area.
 */
export class CollectBlocksSkill implements Skill<CollectInput, CollectOutput> {
  readonly name = 'collect_block'

  constructor(private readonly deps: CollectBlocksDeps) {}

  async run(input: CollectInput, context: SkillContext): Promise<SkillResult<CollectOutput>> {
    const { deps } = this
    const names = expandBlockNames(input.names, deps.blocks.knownBlockNames())
    const before = countItems(deps.inventory.snapshot())
    const skipped = new Set<string>()
    let mined = 0
    let streak = 0
    let lastFailure = ''

    const stop = (reason: string, message: string): SkillResult<CollectOutput> =>
      err({
        reason,
        message: `${message} Collected ${String(mined)} of ${String(input.count)}${this.gainedSuffix(before)}.`,
        detail: { mined, requested: input.count, remaining: input.count - mined },
      })

    while (mined < input.count) {
      if (context.signal.aborted) return stop('aborted', 'Cancelled.')
      const snapshot = deps.inventory.snapshot()
      if (snapshot === undefined)
        return stop('not_connected', 'Not connected to a Minecraft world.')
      if (snapshot.emptySlots === 0)
        return stop(
          'inventory_full',
          'The inventory is full. Free some space (store or drop items), then collect again.',
        )

      const found = deps.finder.find({ names, maxDistance: input.maxDistance, count: CANDIDATES })
      if (!found.ok) return err({ reason: 'unknown_block', message: found.error })
      const here = deps.vitals.read()?.position
      const screened = this.screen(found.value, skipped, here)
      const target = screened.usable[0]
      if (target === undefined)
        return this.noTarget(stop, {
          label: names.join(', '),
          found: found.value.length,
          protectedLabel: screened.protectedLabel,
          skipped: skipped.size,
          lastFailure,
          maxDistance: input.maxDistance,
        })

      const assessment = deps.digger.assess(target.position)
      if (assessment === undefined || !assessment.diggable) {
        skipped.add(keyOf(target.position))
        continue
      }
      if (!assessment.canHarvest) {
        return stop(
          'no_suitable_tool',
          `${target.name} only drops its items when broken with ${assessment.requiredTools.join(', ')}. Craft or find one first.`,
        )
      }

      const skip = (why: string): SkillResult<CollectOutput> | undefined => {
        skipped.add(keyOf(target.position))
        lastFailure = why
        streak += 1
        return streak >= MAX_CONSECUTIVE_SKIPS
          ? stop('unreachable', `Several blocks in a row could not be reached (${why}).`)
          : undefined
      }

      const walked = await deps.navigator.goToPosition(target.position, APPROACH_RANGE, {
        signal: context.signal,
      })
      if (!walked.ok) {
        if (walked.error.reason === 'aborted') return stop('aborted', 'Cancelled.')
        const gaveUp = skip(walked.error.message)
        if (gaveUp !== undefined) return gaveUp
        continue
      }

      let dug = await deps.digger.dig(target.position, context.signal)
      if (!dug.ok && dug.error.reason === 'out_of_reach') {
        const closer = await deps.navigator.goToPosition(target.position, CLOSE_RANGE, {
          signal: context.signal,
        })
        if (closer.ok) dug = await deps.digger.dig(target.position, context.signal)
      }
      if (!dug.ok) {
        if (dug.error.reason === 'aborted') return stop('aborted', 'Cancelled.')
        const gaveUp = skip(dug.error.message)
        if (gaveUp !== undefined) return gaveUp
        continue
      }

      mined += 1
      streak = 0
      input.onMined?.(mined)
      context.progress(`Collected ${String(mined)} of ${String(input.count)} (${target.name})`)
      await deps.drops.collectNear(target.position, context.signal)
    }

    return ok({
      mined,
      requested: input.count,
      gained: gained(before, countItems(deps.inventory.snapshot())),
    })
  }

  /** Keeps the blocks that are safe and sensible to dig. */
  private screen(
    blocks: readonly BlockInfo[],
    skipped: ReadonlySet<string>,
    here: Position | undefined,
  ): { usable: BlockInfo[]; protectedLabel: string | undefined } {
    const usable: BlockInfo[] = []
    let protectedLabel: string | undefined
    for (const block of blocks) {
      if (skipped.has(keyOf(block.position))) continue
      const area = this.deps.guard.protectedAt(block.position)
      if (area !== undefined) {
        protectedLabel ??= area.label
        continue
      }
      if (here !== undefined && this.isUnderFoot(block.position, here)) continue
      if (!this.isExposed(block.position) || this.touchesLava(block.position)) continue
      usable.push(block)
    }
    return { usable, protectedLabel }
  }

  /** Digging the block straight below the bot digs a pit it may not get out of. */
  private isUnderFoot(block: Position, here: Position): boolean {
    return (
      Math.floor(here.x) === block.x &&
      Math.floor(here.z) === block.z &&
      block.y < Math.floor(here.y)
    )
  }

  /** A block is worth digging when open space touches it; a buried one would need tunnelling. */
  private isExposed(block: Position): boolean {
    return NEIGHBOURS.some(
      (offset) =>
        this.deps.blocks.isSolid({
          x: block.x + offset.x,
          y: block.y + offset.y,
          z: block.z + offset.z,
        }) === false,
    )
  }

  /** Breaking a block next to lava lets the lava flow into the hole. */
  private touchesLava(block: Position): boolean {
    return NEIGHBOURS.some((offset) =>
      (
        this.deps.blocks.blockAt({
          x: block.x + offset.x,
          y: block.y + offset.y,
          z: block.z + offset.z,
        }) ?? ''
      ).includes('lava'),
    )
  }

  private noTarget(
    stop: (reason: string, message: string) => SkillResult<CollectOutput>,
    facts: {
      readonly label: string
      readonly found: number
      readonly protectedLabel: string | undefined
      readonly skipped: number
      readonly lastFailure: string
      readonly maxDistance: number
    },
  ): SkillResult<CollectOutput> {
    const { label } = facts
    if (facts.found === 0)
      return stop(
        'block_not_found',
        `No ${label} within ${String(facts.maxDistance)} blocks in the loaded area.`,
      )
    if (facts.protectedLabel !== undefined)
      return stop(
        'protected_area',
        `The nearest ${label} is inside the protected area "${facts.protectedLabel}".`,
      )
    if (facts.skipped > 0)
      return stop(
        'unreachable',
        `The remaining ${label} cannot be reached or dug (${facts.lastFailure}).`,
      )
    return stop(
      'not_reachable_without_tunnelling',
      `The ${label} nearby is buried or unsafe to dig (next to lava, or straight below the bot); the bot does not tunnel.`,
    )
  }

  private gainedSuffix(before: ReadonlyMap<string, number>): string {
    const items = gained(before, countItems(this.deps.inventory.snapshot()))
    return items.length === 0 ? '' : ` (inventory gained ${describeItems(items)})`
  }
}
