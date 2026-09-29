import type { AreaGuard } from '../../core/area-guard.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { BucketFiller, Liquid, LiquidReader } from '../../core/bucket.port.js'
import { countItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillFailure, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import {
  EMPTY_BUCKET,
  filledBucketOf,
  isPlayerBuilt,
  NO_BUCKET_MESSAGE,
  STRUCTURE_RADIUS,
} from './bucket-table.js'
import type { LiquidSpotFinder } from './liquid-spot.js'

/** Sources examined per round: the nearest few are enough, and each one costs a scan of its surroundings. */
const MAX_CANDIDATES = 8
const SEARCH_COUNT = 256
/** A source that refills itself is worth a short detour: the pond stays as it was. */
const REFILL_DETOUR = 6
const APPROACH_TRIES = 3
const HORIZONTAL: readonly Position[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
]

export interface FillBucketInput {
  readonly liquid: Liquid
  /** Buckets to fill; limited by the empty buckets carried. */
  readonly count: number
  /** A source block to take from. Naming it also lets lava be taken from beside a player's build. */
  readonly at: Position | undefined
  readonly maxDistance: number
}

export interface FillBucketOutput {
  readonly liquid: Liquid
  /** What the bot carries now: `water_bucket` or `lava_bucket`. */
  readonly item: string
  readonly filled: number
  readonly requested: number
  /** The blocks the liquid was taken from. */
  readonly from: readonly Position[]
  /** Water only: whether the pool made the taken source again (two sources next to each other do), so it stays. */
  readonly poolRefills: boolean | undefined
  /** Why it stopped short of the count, when it did. */
  readonly stoppedBecause: string | undefined
  readonly message: string
}

export interface FillBucketDeps {
  readonly vitals: VitalsReader
  readonly blocks: BlockScanner
  readonly liquids: LiquidReader
  readonly filler: BucketFiller
  readonly inventory: InventoryReader
  readonly navigator: Navigator
  readonly guard: AreaGuard
  readonly spots: LiquidSpotFinder
}

interface Candidate {
  readonly source: Position
  readonly distance: number
  readonly refills: boolean
}

/** A source the bot cannot use, and the failure that says why. */
type Rejection = SkillFailure

/**
 * Fills empty buckets with water or lava. Only a source block fills a bucket, so the search looks at the block's
 * level, not just its name. Water is easy; **lava is guarded**: never in a protected area, never beside something a
 * player built unless the player named the block, and only from a spot that lava cannot flow onto, taken from the
 * side. The surroundings are read again before every take, because removing a source can let the lava next to it flow
 * into the gap. Other items are never touched, so a water bucket that is carried stays for the reflexes.
 */
export class FillBucketSkill implements Skill<FillBucketInput, FillBucketOutput> {
  readonly name = 'fill_bucket'

  constructor(private readonly deps: FillBucketDeps) {}

  async run(input: FillBucketInput, context: SkillContext): Promise<SkillResult<FillBucketOutput>> {
    const { deps } = this
    if (deps.vitals.read() === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
    const snapshot = deps.inventory.snapshot()
    const buckets = countItems(snapshot).get(EMPTY_BUCKET) ?? 0
    if (buckets === 0) return err({ reason: 'no_bucket', message: NO_BUCKET_MESSAGE })
    // A filled bucket does not stack with the rest of the empty ones: it needs a slot of its own.
    if ((snapshot?.emptySlots ?? 0) === 0 && buckets > 1)
      return err({
        reason: 'inventory_full',
        message: 'There is no free inventory slot for a filled bucket. Free one and try again.',
      })
    const target = Math.min(input.count, buckets)

    const from: Position[] = []
    let refills: boolean | undefined
    let stoppedBecause: string | undefined
    while (from.length < target) {
      if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
      const taken = await this.takeOne(input, context)
      if (!taken.ok) {
        if (from.length === 0 || taken.error.reason === 'aborted') return taken
        stoppedBecause = taken.error.message
        break
      }
      from.push(taken.value.source)
      if (input.liquid === 'water') refills = (refills ?? true) && taken.value.refilled
      context.progress(`Filled ${String(from.length)} of ${String(target)}`)
      if (taken.value.stop !== undefined) {
        stoppedBecause = taken.value.stop
        break
      }
    }
    if (from.length < input.count && stoppedBecause === undefined)
      stoppedBecause = `only ${String(buckets)} empty bucket(s) carried`
    return ok(this.report(input, from, refills, stoppedBecause))
  }

  private report(
    input: FillBucketInput,
    from: readonly Position[],
    refills: boolean | undefined,
    stoppedBecause: string | undefined,
  ): FillBucketOutput {
    const item = filledBucketOf(input.liquid)
    const parts = [`Filled ${String(from.length)} ${item}.`]
    if (refills === true) parts.push('The pool makes its sources again, so it stays as it was.')
    if (refills === false)
      parts.push('The pool has no second source next to the taken one, so it is drained there.')
    if (stoppedBecause !== undefined) parts.push(`Stopped early: ${stoppedBecause}.`)
    return {
      liquid: input.liquid,
      item,
      filled: from.length,
      requested: input.count,
      from,
      poolRefills: refills,
      stoppedBecause,
      message: parts.join(' '),
    }
  }

  /** One bucket: pick a usable source, walk to a safe spot, take it. */
  private async takeOne(
    input: FillBucketInput,
    context: SkillContext,
  ): Promise<SkillResult<{ source: Position; refilled: boolean; stop: string | undefined }>> {
    const { deps } = this
    const found = this.candidates(input)
    if (!found.ok) return found

    let first: Rejection | undefined
    for (const candidate of found.value) {
      const rejection = this.rejects(candidate.source, input)
      if (rejection !== undefined) {
        first ??= rejection
        continue
      }
      const ready = await this.approach(candidate.source, input.liquid, context)
      if (!ready.ok) {
        if (ready.error.reason === 'aborted') return ready
        first ??= ready.error
        continue
      }
      // Whether the pool remakes this block is read before the take, from what surrounds it.
      const refilled = input.liquid === 'water' && candidate.refills
      const filled = await deps.filler.fill(candidate.source, context.signal)
      if (!filled.ok) {
        if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
        return err({ reason: filled.error.reason, message: filled.error.message })
      }
      // The bucket is full either way; a warning only ends the run after it.
      return ok({ source: candidate.source, refilled, stop: this.lavaWarning(input.liquid) })
    }
    return err(
      first ?? {
        reason: 'no_source',
        message: `There is no ${input.liquid} source block within ${String(input.maxDistance)} blocks.`,
      },
    )
  }

  /** The sources to try, best first: the named one, or the nearest with the refilling ones preferred. */
  private candidates(input: FillBucketInput): SkillResult<readonly Candidate[]> {
    const { deps } = this
    const here = deps.vitals.read()?.position
    if (here === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
    if (input.at !== undefined) {
      const state = deps.liquids.liquidAt(input.at)
      const where = `${String(input.at.x)}, ${String(input.at.y)}, ${String(input.at.z)}`
      if (state === undefined)
        return err({
          reason: 'not_a_source',
          message: `There is no ${input.liquid} at ${where} (${deps.blocks.blockAt(input.at) ?? 'not loaded'}).`,
        })
      if (state.liquid !== input.liquid)
        return err({
          reason: 'not_a_source',
          message: `The liquid at ${where} is ${state.liquid}, not ${input.liquid}.`,
        })
      if (!state.source)
        return err({
          reason: 'not_a_source',
          message: `The ${input.liquid} at ${where} is flowing, not a source block: a bucket takes nothing from it.`,
        })
      return ok([this.candidateOf(input.at, here)])
    }
    const nearby = deps.blocks.findBlocks({
      names: [input.liquid],
      maxDistance: input.maxDistance,
      count: SEARCH_COUNT,
    })
    const sources = nearby
      .filter((block) => {
        const state = deps.liquids.liquidAt(block.position)
        return state?.liquid === input.liquid && state.source
      })
      .map((block) => this.candidateOf(block.position, here))
    if (sources.length === 0)
      return err({
        reason: 'no_source',
        message:
          nearby.length === 0
            ? `There is no ${input.liquid} within ${String(input.maxDistance)} blocks.`
            : `There is ${input.liquid} within ${String(input.maxDistance)} blocks, but only flowing: a bucket needs a source block.`,
      })
    const nearest = Math.min(...sources.map((source) => source.distance))
    const ordered = [...sources].sort((a, b) => {
      const detourA = a.refills && a.distance <= nearest + REFILL_DETOUR ? 0 : 1
      const detourB = b.refills && b.distance <= nearest + REFILL_DETOUR ? 0 : 1
      return detourA - detourB || a.distance - b.distance
    })
    return ok(ordered.slice(0, MAX_CANDIDATES))
  }

  private candidateOf(source: Position, from: Position): Candidate {
    return {
      source,
      distance: distanceBetween(from, { x: source.x + 0.5, y: source.y, z: source.z + 0.5 }),
      refills: this.refillsAfterTake(source),
    }
  }

  /**
   * Water flows back into a cell that has two water sources beside it (on the sides) and ground or water below, so
   * taking such a block leaves the pool as it was.
   */
  private refillsAfterTake(source: Position): boolean {
    let neighbours = 0
    for (const offset of HORIZONTAL) {
      const cell = { x: source.x + offset.x, y: source.y, z: source.z + offset.z }
      const state = this.deps.liquids.liquidAt(cell)
      if (state?.liquid === 'water' && state.source) neighbours += 1
    }
    if (neighbours < 2) return false
    const below = { x: source.x, y: source.y - 1, z: source.z }
    return (
      this.deps.blocks.isSolid(below) === true || this.deps.liquids.liquidAt(below)?.source === true
    )
  }

  /** Why this source may not be taken, or undefined when it may. */
  private rejects(source: Position, input: FillBucketInput): Rejection | undefined {
    const area = this.deps.guard.protectedAt(source)
    if (area !== undefined)
      return {
        reason: 'protected_area',
        message: `The ${input.liquid} is inside the protected area "${area.label}". It is left alone.`,
      }
    if (input.liquid !== 'lava' || input.at !== undefined) return undefined
    const built = this.builtNear(source)
    if (built === undefined) return undefined
    return {
      reason: 'structure_nearby',
      message: `A player-built block (${built.name}) is within ${String(STRUCTURE_RADIUS)} blocks of the lava at ${String(source.x)}, ${String(source.y)}, ${String(source.z)}. Ask the player which lava block to take, then pass it as "at".`,
      detail: { structure: built.name, at: built.at },
    }
  }

  private builtNear(source: Position): { name: string; at: Position } | undefined {
    for (let dx = -STRUCTURE_RADIUS; dx <= STRUCTURE_RADIUS; dx += 1)
      for (let dy = -STRUCTURE_RADIUS; dy <= STRUCTURE_RADIUS; dy += 1)
        for (let dz = -STRUCTURE_RADIUS; dz <= STRUCTURE_RADIUS; dz += 1) {
          const at = { x: source.x + dx, y: source.y + dy, z: source.z + dz }
          const name = this.deps.blocks.blockAt(at)
          if (name !== undefined && isPlayerBuilt(name)) return { name, at }
        }
    return undefined
  }

  /** Walks to a spot the take can be made from, choosing again from where the bot really ended up. */
  private async approach(
    source: Position,
    liquid: Liquid,
    context: SkillContext,
  ): Promise<SkillResult<void>> {
    const { deps } = this
    for (let attempt = 0; attempt <= APPROACH_TRIES; attempt += 1) {
      const here = deps.vitals.read()?.position
      if (here === undefined)
        return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
      const spot = deps.spots.find({ liquid, source, from: here })
      if (spot === undefined)
        return err({
          reason: 'no_safe_spot',
          message:
            liquid === 'lava'
              ? `There is no spot near the lava at ${String(source.x)}, ${String(source.y)}, ${String(source.z)} where the bot can stand with no lava beside or above it and reach the source from the side.`
              : `There is no spot within reach of the water at ${String(source.x)}, ${String(source.y)}, ${String(source.z)} to stand on.`,
        })
      if (spot === here) return ok(undefined)
      if (attempt === APPROACH_TRIES) break
      const walked = await deps.navigator.goToPosition(spot, 0.5, { signal: context.signal })
      if (!walked.ok) {
        if (walked.error.reason === 'aborted')
          return err({ reason: 'aborted', message: 'Cancelled.' })
        return err({
          reason: 'unreachable',
          message: `Could not walk to a spot beside the ${liquid}: ${walked.error.message}`,
        })
      }
    }
    return err({
      reason: 'unreachable',
      message: `Could not get to a spot beside the ${liquid}.`,
    })
  }

  /** After a lava take, the bot's own spot must still be out of lava's reach (the gap may have let it flow). */
  private lavaWarning(liquid: Liquid): string | undefined {
    if (liquid !== 'lava') return undefined
    const position = this.deps.vitals.read()?.position
    if (position === undefined || this.deps.spots.lavaSafe(position)) return undefined
    return 'lava flowed close to the bot after the take, so no more was taken (the lava reflex looks after the bot)'
  }
}
