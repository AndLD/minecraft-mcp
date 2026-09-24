import type { AreaGuard } from '../../core/area-guard.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Digger } from '../../core/digger.port.js'
import { countItems, gained } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Placer } from '../../core/placer.port.js'
import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { FarmEntry, FarmRegistry } from '../../state/farm-registry.js'
import type { DropCollector } from '../gathering/drop-collector.js'
import type { Bounds } from './farm-area.types.js'
import { insideBounds } from './farm-area.types.js'
import { scanGrove, spotCells } from './grove-scan.js'
import { isLogName, isPlantableGround, speciesOfLog } from './tree-table.js'

const REACH = 3
const CLOSE = 1.5
/** A trunk is followed this far sideways and up from its base, and no more than this many logs are felled per tree. */
const HORIZONTAL_LIMIT = 6
const VERTICAL_LIMIT = 24
const MAX_LOGS_PER_TREE = 96
const SEARCH_DISTANCE = 64
const MAX_FOUND = 500

export interface HarvestTreesInput {
  readonly farm: string | undefined
  readonly area: Bounds | undefined
  /** Plant a sapling where each tree stood, when the whole tree came down. */
  readonly replant: boolean
  /** Stop after felling this many trees. */
  readonly maxTrees: number | undefined
}

export interface HarvestTreesOutput {
  /** Trees felled completely. */
  readonly trees: number
  readonly logs: number
  /** Logs of a tree the bot could not reach or was not allowed to break, so the tree still stands in part. */
  readonly left: number
  readonly replanted: number
  /** Saplings the bot lacked for the spots it wanted to replant. */
  readonly saplingsMissing: number
  readonly gained: readonly ItemCount[]
}

export interface HarvestTreesDeps {
  readonly blocks: BlockScanner
  readonly navigator: Navigator
  readonly digger: Digger
  readonly placer: Placer
  readonly drops: DropCollector
  readonly inventory: InventoryReader
  readonly guard: AreaGuard
  readonly farms: FarmRegistry
}

const key = (position: Position): string => `${String(position.x)},${String(position.y)},${String(position.z)}`

const NEIGHBOURS: readonly Position[] = (() => {
  const result: Position[] = []
  for (let dx = -1; dx <= 1; dx += 1)
    for (let dy = -1; dy <= 1; dy += 1)
      for (let dz = -1; dz <= 1; dz += 1) if (dx !== 0 || dy !== 0 || dz !== 0) result.push({ x: dx, y: dy, z: dz })
  return result
})()

/**
 * Fells the grown trees of a grove, or of an area, and replants each spot when the whole tree came down. Deliberate
 * by design: a registered grove is protected from `collect_block`, and only this skill cuts it. It works from the
 * ground and stops at what the bot can reach, so the top of a tall tree can stay (reported as `left`, and such a
 * tree is not replanted, since the logs left would block the new one). Leaves are not cut: they decay by themselves
 * and drop saplings and apples as they do.
 */
export class HarvestTreesSkill implements Skill<HarvestTreesInput, HarvestTreesOutput> {
  readonly name = 'harvest_trees'

  constructor(private readonly deps: HarvestTreesDeps) {}

  async run(
    input: HarvestTreesInput,
    context: SkillContext,
  ): Promise<SkillResult<HarvestTreesOutput>> {
    const entry = input.farm === undefined ? undefined : this.deps.farms.resolve(input.farm)
    if (input.farm !== undefined && entry === undefined)
      return err({ reason: 'unknown_farm', message: `There is no farm "${input.farm}". See list_farms.` })
    if (entry !== undefined && entry.kind !== 'grove')
      return err({
        reason: 'not_a_grove',
        message: `${entry.label ?? entry.id} is a ${entry.kind}, not a grove. Give an area instead.`,
      })
    const bounds = input.area ?? entry?.bounds
    if (bounds === undefined)
      return err({ reason: 'no_area', message: 'Give a grove or an area to harvest.' })

    const before = countItems(this.deps.inventory.snapshot())
    const ownLabel = entry === undefined ? undefined : (entry.label ?? entry.id)
    let trees = 0
    let logs = 0
    let left = 0
    let replanted = 0
    let saplingsMissing = 0
    let aborted = false

    for (const base of this.baseCells(entry, bounds)) {
      if (context.signal.aborted) {
        aborted = true
        break
      }
      if (input.maxTrees !== undefined && trees >= input.maxTrees) break
      const startName = this.deps.blocks.blockAt(base)
      if (startName === undefined || !isLogName(startName)) continue

      const felled = await this.fell(base, startName, ownLabel, context)
      logs += felled.dug
      left += felled.left
      if (felled.aborted) {
        aborted = true
        break
      }
      await this.deps.drops.collectNear(base, context.signal)
      if (felled.left > 0) continue
      trees += 1
      context.progress(`Felled ${String(trees)} tree(s)`)

      const species = speciesOfLog(startName)
      if (input.replant && species !== undefined) {
        const carried = countItems(this.deps.inventory.snapshot()).get(species.sapling) ?? 0
        let available = carried
        for (const cell of felled.bases) {
          if (available <= 0) {
            saplingsMissing += 1
            continue
          }
          const placed = await this.deps.placer.placeAt(species.sapling, cell)
          if (placed.ok) {
            replanted += 1
            available -= 1
          }
        }
      }
    }

    const result = {
      trees,
      logs,
      left,
      replanted,
      saplingsMissing,
      gained: gained(before, countItems(this.deps.inventory.snapshot())),
    }
    if (aborted)
      return err({
        reason: 'aborted',
        message: `Cancelled after felling ${String(trees)} tree(s).`,
        detail: result,
      })
    return ok(result)
  }

  /** The cells where a trunk starts: a grove's recorded spots, or the trunks found standing on dirt in the bounds. */
  private baseCells(entry: FarmEntry | undefined, bounds: Bounds): readonly Position[] {
    if (entry !== undefined && entry.spots !== null)
      return scanGrove(entry, this.deps.blocks)
        .filter((site) => site.state === 'grown')
        .flatMap((site) => spotCells(site.spot))
    const names = this.deps.blocks.knownBlockNames().filter(isLogName)
    if (names.length === 0) return []
    return this.deps.blocks
      .findBlocks({ names, maxDistance: SEARCH_DISTANCE, count: MAX_FOUND })
      .filter((block) => insideBounds(block.position, bounds))
      .filter((block) => {
        const below = this.deps.blocks.blockAt({ ...block.position, y: block.position.y - 1 })
        return below !== undefined && isPlantableGround(below)
      })
      .map((block) => block.position)
  }

  private async fell(
    base: Position,
    logName: string,
    ownLabel: string | undefined,
    context: SkillContext,
  ): Promise<{ dug: number; left: number; bases: Position[]; aborted: boolean }> {
    const trunk = this.connectedLogs(base, logName)
    const bases = trunk.filter((log) => {
      const below = this.deps.blocks.blockAt({ ...log, y: log.y - 1 })
      return below !== undefined && isPlantableGround(below)
    })
    let dug = 0
    let left = 0
    for (const log of trunk) {
      if (context.signal.aborted) return { dug, left, bases, aborted: true }
      const guarded = this.deps.guard.protectedAt(log)
      if (guarded !== undefined && guarded.label !== ownLabel) {
        left += 1
        continue
      }
      if (this.deps.blocks.blockAt(log) !== logName) continue
      const outcome = await this.cut(log, context)
      if (outcome === 'aborted') return { dug, left, bases, aborted: true }
      if (outcome === 'dug') {
        dug += 1
        // Each log's drop is picked up as it falls, like collect_block does per block: a whole tree's drops at
        // once can leave the last one (which falls furthest) out of the sweep.
        await this.deps.drops.collectNear(log, context.signal)
      } else left += 1
    }
    return { dug, left, bases, aborted: false }
  }

  /** Breaks one log from close by: walks within reach first, and closer when the dig says it is too far. */
  private async cut(log: Position, context: SkillContext): Promise<'dug' | 'left' | 'aborted'> {
    for (const within of [REACH, CLOSE]) {
      const walked = await this.deps.navigator.goToPosition(log, within, { signal: context.signal })
      if (!walked.ok) {
        if (walked.error.reason === 'aborted') return 'aborted'
        continue
      }
      const dug = await this.deps.digger.dig(log, context.signal)
      if (dug.ok) return 'dug'
      if (dug.error.reason === 'aborted') return 'aborted'
      if (dug.error.reason !== 'out_of_reach') return 'left'
    }
    return 'left'
  }

  /** The logs of one tree, lowest first: everything of the same wood touching the trunk, within a limit. */
  private connectedLogs(base: Position, logName: string): readonly Position[] {
    const seen = new Set<string>([key(base)])
    const queue: Position[] = [base]
    const found: Position[] = []
    while (queue.length > 0 && found.length < MAX_LOGS_PER_TREE) {
      const current = queue.shift()
      if (current === undefined) break
      found.push(current)
      for (const step of NEIGHBOURS) {
        const next = { x: current.x + step.x, y: current.y + step.y, z: current.z + step.z }
        if (seen.has(key(next))) continue
        if (Math.abs(next.x - base.x) > HORIZONTAL_LIMIT || Math.abs(next.z - base.z) > HORIZONTAL_LIMIT) continue
        if (next.y < base.y || next.y > base.y + VERTICAL_LIMIT) continue
        seen.add(key(next))
        if (this.deps.blocks.blockAt(next) === logName) queue.push(next)
      }
    }
    return found.sort((a, b) => a.y - b.y)
  }
}
