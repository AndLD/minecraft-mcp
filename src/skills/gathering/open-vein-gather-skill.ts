import type { BlockInfo, BlockScanner } from '../../core/block-scanner.port.js'
import type { Clock } from '../../core/clock.port.js'
import { countItems, gained } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { BlockFinder } from '../../perception/block-finder.js'
import type { InventoryFullKind } from '../../state/storage-policy.js'
import { canStandBeside, reachedKeys, type CaveMap } from '../discovery/caves/cave-map.js'
import type {
  ExploreCavesInput,
  ExploreCavesOutput,
} from '../discovery/caves/explore-caves-skill.js'
import { expandBlockNames } from './block-aliases.js'
import type { CollectInput, CollectOutput } from './collect-blocks-skill.js'

export interface OpenVeinInput {
  /** Ore names or the `ores` group. */
  readonly names: readonly string[]
  readonly count: number
  /** How far to look for veins in view, in blocks. */
  readonly maxDistance: number
  /** How long the whole job may take, in minutes. */
  readonly maxMinutes: number
  /** When no open vein can be found, tunnel to the nearest buried one (`dig_to`) instead of giving up. */
  readonly tunnel: boolean
  readonly onInventoryFull?: InventoryFullKind | undefined
  readonly onMined?: ((mined: number) => void) | undefined
}

export interface OpenVeinOutput extends CollectOutput {
  /** Open veins found by exploring caves, and buried ones tunnelled to. */
  readonly explored: number
  readonly tunnelled: number
}

/** Runs `collect_block` for the veins the bot can walk to. */
export interface VeinCollector {
  run(input: CollectInput, context: SkillContext): Promise<SkillResult<CollectOutput>>
}
/** Runs `explore_caves`. */
export interface CaveExplorer {
  run(input: ExploreCavesInput, context: SkillContext): Promise<SkillResult<ExploreCavesOutput>>
}
/** Digs a route to one buried block (`excavate` with `dig_to`). */
export interface VeinTunneler {
  tunnelTo(target: Position, context: SkillContext): Promise<SkillResult<unknown>>
}

export interface OpenVeinDeps {
  readonly collect: VeinCollector
  readonly explore: CaveExplorer
  readonly tunneler?: VeinTunneler
  readonly blocks: BlockScanner
  readonly finder: BlockFinder
  readonly map: CaveMap
  readonly vitals: VitalsReader
  readonly inventory: InventoryReader
  readonly clock: Clock
}

/** Failures of the collector that mean "nothing left to dig here": the search for more veins goes on. */
const NO_MORE_HERE = new Set(['block_not_found', 'unreachable', 'not_reachable_without_tunnelling'])
/** Explore-and-collect rounds before giving up. */
const MAX_ROUNDS = 12
const CANDIDATES = 64
const MINUTE_MS = 60_000
/** A buried vein is looked for this far at least: the bot may have walked a long way into a cave by then. */
const BURIED_RANGE = 64
const REACH_CELLS = 8000

const NEIGHBOURS: readonly Position[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
]

/** Whether a name is an ore (a vein): the only blocks gathered this way. */
export const isVeinName = (name: string): boolean =>
  name === 'ores' || name === 'ancient_debris' || name.endsWith('_ore')

/**
 * Gathers ore the way a player would: veins that can be walked up to first. What is in view and has a walkable way to it
 * is dug; when there is none, caves are explored (lit, hazard-aware) until one comes into view; only when asked, and
 * only when no open vein can be found, is a route dug to a buried one.
 */
export class OpenVeinGatherSkill implements Skill<OpenVeinInput, OpenVeinOutput> {
  readonly name = 'collect_block'

  constructor(private readonly deps: OpenVeinDeps) {}

  async run(input: OpenVeinInput, context: SkillContext): Promise<SkillResult<OpenVeinOutput>> {
    const { deps } = this
    const names = expandBlockNames(input.names, deps.blocks.knownBlockNames())
    const before = countItems(deps.inventory.snapshot())
    const startedAt = deps.clock.now()
    let mined = 0
    let explored = 0
    let tunnelled = 0
    let rounds = 0
    let lastExplore: string | undefined

    const stop = (reason: string, message: string): SkillResult<OpenVeinOutput> =>
      err({
        reason,
        message: `${message} Collected ${String(mined)} of ${String(input.count)}.`,
        detail: {
          mined,
          requested: input.count,
          remaining: input.count - mined,
          explored,
          tunnelled,
        },
      })

    while (mined < input.count) {
      if (context.signal.aborted) return stop('aborted', 'Cancelled.')
      const here = deps.vitals.read()?.position
      if (here === undefined) return stop('not_connected', 'Not connected to a Minecraft world.')

      const open = this.openVeins(names, here, input.maxDistance)
      if (open.veins.length > 0) {
        const done = await this.dig(input, names, open.reached, mined, context)
        mined += done.mined
        if (done.error !== undefined && !NO_MORE_HERE.has(done.error.reason))
          return err({
            ...done.error,
            detail: { ...done.error.detail, mined, requested: input.count, explored, tunnelled },
          })
        if (done.mined > 0) continue
      }

      rounds += 1
      const minutesLeft = input.maxMinutes - (deps.clock.now() - startedAt) / MINUTE_MS
      if (rounds > MAX_ROUNDS || minutesLeft <= 0)
        return stop('no_open_vein', 'Ran out of time looking for veins that can be walked to.')

      context.progress(`No open vein in reach: exploring caves for ${names.join(', ')}`)
      const trip = await deps.explore.run(
        {
          find: names,
          mine: false,
          maxDistance: 150,
          maxMinutes: Math.max(1, minutesLeft),
          minLight: 5,
          stopOnFind: true,
          returnOut: false,
        },
        context,
      )
      if (!trip.ok) {
        if (trip.error.reason === 'aborted') return stop('aborted', 'Cancelled.')
        lastExplore = trip.error.reason
        break
      }
      lastExplore = trip.value.stopped
      if (trip.value.stopped === 'found') {
        explored += 1
        continue
      }
      break
    }
    if (mined >= input.count) return this.finish(input, before, mined, explored, tunnelled)

    // No open vein to be found: tunnel to a buried one when that was asked for.
    if (input.tunnel && deps.tunneler !== undefined) {
      while (mined < input.count) {
        if (context.signal.aborted) return stop('aborted', 'Cancelled.')
        const target = this.buriedVein(names, Math.max(input.maxDistance, BURIED_RANGE))
        if (target === undefined) break
        context.progress(
          `Digging a route to ${target.name} at ${String(target.position.x)}, ${String(target.position.y)}, ${String(target.position.z)}`,
        )
        const tunnel = await deps.tunneler.tunnelTo(target.position, context)
        if (!tunnel.ok) {
          if (tunnel.error.reason === 'aborted') return stop('aborted', 'Cancelled.')
          return err({
            ...tunnel.error,
            message: `${tunnel.error.message} Collected ${String(mined)} of ${String(input.count)}.`,
            detail: { ...tunnel.error.detail, mined, requested: input.count, explored, tunnelled },
          })
        }
        // The route ends by breaking the vein block; if it is still there, nothing was gained and the loop would repeat.
        if (deps.blocks.blockAt(target.position) === target.name) break
        tunnelled += 1
        mined += 1
        input.onMined?.(mined)
      }
      if (mined >= input.count) return this.finish(input, before, mined, explored, tunnelled)
    }

    const buried = this.buriedVein(names, Math.max(input.maxDistance, BURIED_RANGE))
    return stop(
      'no_open_vein',
      `No ${names.length === 1 ? (names[0] ?? 'ore') : 'such ore'} with a way to it was found (cave search ended: ${lastExplore ?? 'not started'}).${
        buried === undefined
          ? ''
          : ` A buried one lies at ${String(buried.position.x)}, ${String(buried.position.y)}, ${String(buried.position.z)}: call again with search "open_then_tunnel" to dig a route to it.`
      }`,
    )
  }

  private finish(
    input: OpenVeinInput,
    before: ReadonlyMap<string, number>,
    mined: number,
    explored: number,
    tunnelled: number,
  ): SkillResult<OpenVeinOutput> {
    return ok({
      mined,
      requested: input.count,
      gained: gained(before, countItems(this.deps.inventory.snapshot())),
      explored,
      tunnelled,
    })
  }

  /** Digs what is open and reachable; reports how many were dug and why it stopped short, if it did. */
  private async dig(
    input: OpenVeinInput,
    names: readonly string[],
    reached: ReadonlySet<string>,
    already: number,
    context: SkillContext,
  ): Promise<{
    mined: number
    error?: { reason: string; message: string; detail?: Readonly<Record<string, unknown>> }
  }> {
    const collected = await this.deps.collect.run(
      {
        names,
        count: input.count - already,
        maxDistance: input.maxDistance,
        onInventoryFull: input.onInventoryFull,
        accept: (block: BlockInfo) => canStandBeside(block.position, reached),
        onMined: (count) => input.onMined?.(already + count),
      },
      context,
    )
    if (collected.ok) return { mined: collected.value.mined }
    const done = (collected.error.detail as { mined?: number } | undefined)?.mined ?? 0
    return { mined: done, error: collected.error }
  }

  /** Veins in view that touch open space and have a walkable way to them, and the cells the bot can walk to. */
  private openVeins(
    names: readonly string[],
    here: Position,
    maxDistance: number,
  ): { veins: BlockInfo[]; reached: Set<string> } {
    const found = this.deps.finder.find({ names, maxDistance, count: CANDIDATES })
    if (!found.ok || found.value.length === 0) return { veins: [], reached: new Set() }
    const reached = reachedKeys(
      this.deps.map.reach(here, Math.min(48, maxDistance), REACH_CELLS).cells,
    )
    const veins = found.value.filter(
      (block) => this.isExposed(block.position) && canStandBeside(block.position, reached),
    )
    return { veins, reached }
  }

  /** The nearest vein in view with no open side and no walkable way: one that would have to be tunnelled to. */
  private buriedVein(names: readonly string[], maxDistance: number): BlockInfo | undefined {
    const found = this.deps.finder.find({ names, maxDistance, count: CANDIDATES })
    if (!found.ok) return undefined
    return found.value.find((block) => !this.isExposed(block.position))
  }

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
}
