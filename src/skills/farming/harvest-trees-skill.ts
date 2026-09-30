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
import type { VitalsReader } from '../../core/vitals.port.js'
import type { FarmEntry, FarmRegistry } from '../../state/farm-registry.js'
import type { Scaffolder } from '../construction/scaffolder.js'
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
/** The block a tower is made of: dirt breaks by hand and is picked up again when the tower comes down. */
const SCAFFOLD_BLOCK = 'dirt'
/** A tower for one tree is never higher than this (the same default as the building scaffold). */
const MAX_TOWER_HEIGHT = 12
/** Tries to reach one log from the tower (each try may add a block to it). */
const TOWER_TRIES = MAX_TOWER_HEIGHT + 2
/** A tower column that needs more leaves dug than this is not used. */
const MAX_LEAVES_IN_COLUMN = 12

export interface HarvestTreesInput {
  readonly farm: string | undefined
  readonly area: Bounds | undefined
  /** Plant a sapling where each tree stood, when the whole tree came down. */
  readonly replant: boolean
  /** Stop after felling this many trees. */
  readonly maxTrees: number | undefined
  /** `pillar` (default when omitted) climbs a tower of dirt to finish tall trees; `skip` leaves the top out of reach. */
  readonly reachTall?: 'pillar' | 'skip'
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
  /** Dirt the bot lacked for the tower a tall tree needed (that tree's top logs stayed). */
  readonly scaffoldMissing: number
  /** Leaves dug out of the way of a tower (the canopy is otherwise left to decay). */
  readonly leavesCut: number
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
  /** Pillars up beside a tall tree. Without it (or without vitals) tall trees are left as they were. */
  readonly scaffolder?: TowerBuilder
  readonly vitals?: VitalsReader
}

/** The part of the `Scaffolder` a tree needs (the whole class fits). */
export type TowerBuilder = Pick<Scaffolder, 'plan' | 'raise' | 'pillarOnce' | 'lower'>

const key = (position: Position): string =>
  `${String(position.x)},${String(position.y)},${String(position.z)}`

const NEIGHBOURS: readonly Position[] = (() => {
  const result: Position[] = []
  for (let dx = -1; dx <= 1; dx += 1)
    for (let dy = -1; dy <= 1; dy += 1)
      for (let dz = -1; dz <= 1; dz += 1)
        if (dx !== 0 || dy !== 0 || dz !== 0) result.push({ x: dx, y: dy, z: dz })
  return result
})()

/**
 * Fells the grown trees of a grove, or of an area, and replants each spot when the whole tree came down. Deliberate
 * by design: a registered grove is protected from `collect_block`, and only this skill cuts it. It works from the
 * ground, and when the top of a tall tree is out of reach it climbs a tower of dirt beside the trunk (`reachTall:
 * 'pillar'`, the default) and takes it down again. A tree it cannot finish (no safe spot for a tower, no dirt, over
 * the height limit) keeps its top, reported as `left`, and is not replanted, since the logs left would block the new one. Leaves are not cut: they decay by themselves
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
      return err({
        reason: 'unknown_farm',
        message: `There is no farm "${input.farm}". See list_farms.`,
      })
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
    let scaffoldMissing = 0
    let leavesCut = 0
    let aborted = false

    for (const base of this.baseCells(entry, bounds)) {
      if (context.signal.aborted) {
        aborted = true
        break
      }
      if (input.maxTrees !== undefined && trees >= input.maxTrees) break
      const startName = this.deps.blocks.blockAt(base)
      if (startName === undefined || !isLogName(startName)) continue

      const felled = await this.fell(base, startName, ownLabel, input.reachTall !== 'skip', context)
      logs += felled.dug
      left += felled.left
      scaffoldMissing += felled.scaffoldMissing
      leavesCut += felled.leavesCut
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
      scaffoldMissing,
      leavesCut,
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
    pillar: boolean,
    context: SkillContext,
  ): Promise<{
    dug: number
    left: number
    scaffoldMissing: number
    leavesCut: number
    bases: Position[]
    aborted: boolean
  }> {
    const trunk = this.connectedLogs(base, logName)
    const bases = trunk.filter((log) => {
      const below = this.deps.blocks.blockAt({ ...log, y: log.y - 1 })
      return below !== undefined && isPlantableGround(below)
    })
    let dug = 0
    let left = 0
    for (const [index, log] of trunk.entries()) {
      if (context.signal.aborted)
        return { dug, left, scaffoldMissing: 0, leavesCut: 0, bases, aborted: true }
      if (this.isOthers(log, ownLabel)) {
        left += 1
        continue
      }
      if (this.deps.blocks.blockAt(log) !== logName) continue
      const outcome = await this.cut(log, context)
      if (outcome === 'aborted')
        return { dug, left, scaffoldMissing: 0, leavesCut: 0, bases, aborted: true }
      if (outcome === 'dug') {
        dug += 1
        // Each log's drop is picked up as it falls, like collect_block does per block: a whole tree's drops at
        // once can leave the last one (which falls furthest) out of the sweep.
        await this.deps.drops.collectNear(log, context.signal)
      } else if (outcome === 'high' && pillar && this.canPillar()) {
        // Everything from here up is out of the ground's reach: climb once and do the rest from the tower.
        const high = await this.fellFromTower(trunk.slice(index), logName, ownLabel, context)
        return {
          dug: dug + high.dug,
          left: left + high.left,
          scaffoldMissing: high.missing,
          leavesCut: high.leavesCut,
          bases,
          aborted: high.aborted,
        }
      } else left += 1
    }
    return { dug, left, scaffoldMissing: 0, leavesCut: 0, bases, aborted: false }
  }

  private isOthers(log: Position, ownLabel: string | undefined): boolean {
    const guarded = this.deps.guard.protectedAt(log)
    return guarded !== undefined && guarded.label !== ownLabel
  }

  /** A leaf of the tree's own kind that may be dug: not inside somebody else's protected area. */
  private isOwnLeaf(cell: Position, leaves: string, ownLabel: string | undefined): boolean {
    return this.deps.blocks.blockAt(cell) === leaves && !this.isOthers(cell, ownLabel)
  }

  private canPillar(): boolean {
    return this.deps.scaffolder !== undefined && this.deps.vitals !== undefined
  }

  /**
   * Builds a tower beside the lowest of `logs` (all too high for the ground), digs every one it can reach from it,
   * raising the tower a block when the next log is still too far, and always takes the tower down again. Logs it
   * could not reach (no safe place for a tower, no dirt, the height limit, a protected log) count as left.
   */
  private async fellFromTower(
    logs: readonly Position[],
    logName: string,
    ownLabel: string | undefined,
    context: SkillContext,
  ): Promise<{ dug: number; left: number; missing: number; leavesCut: number; aborted: boolean }> {
    const { scaffolder, vitals } = this.deps
    const leaves = logName.replace(/_log$/, '_leaves')
    const first = logs[0]
    const here = vitals?.read()?.position
    if (scaffolder === undefined || first === undefined || here === undefined)
      return { dug: 0, left: logs.length, missing: 0, leavesCut: 0, aborted: false }
    const tower = scaffolder.plan({
      target: first,
      from: here,
      reserved: new Set(),
      maxHeight: MAX_TOWER_HEIGHT,
      passable: (cell) => this.isOwnLeaf(cell, leaves, ownLabel),
      maxClear: MAX_LEAVES_IN_COLUMN,
    })
    if (tower === undefined)
      return { dug: 0, left: logs.length, missing: 0, leavesCut: 0, aborted: false }
    const carried = countItems(this.deps.inventory.snapshot()).get(SCAFFOLD_BLOCK) ?? 0
    if (carried < tower.height)
      return {
        dug: 0,
        left: logs.length,
        missing: tower.height - carried,
        leavesCut: 0,
        aborted: false,
      }

    const raised = await scaffolder.raise(tower, SCAFFOLD_BLOCK, context.signal)
    const built = raised.ok ? raised.value : raised.error.tower
    let dug = 0
    let left = 0
    let aborted = false
    try {
      if (!raised.ok)
        return {
          dug,
          left: logs.length,
          missing: 0,
          leavesCut: built.leavesCut ?? 0,
          aborted: raised.error.reason === 'aborted',
        }
      for (const log of logs) {
        if (context.signal.aborted) {
          aborted = true
          break
        }
        if (this.deps.blocks.blockAt(log) !== logName) continue
        if (this.isOthers(log, ownLabel)) {
          left += 1
          continue
        }
        if (await this.cutFromTower(log, built, scaffolder, context)) dug += 1
        else left += 1
      }
    } finally {
      await scaffolder.lower(built)
    }
    // The drops of the high logs fell around the trunk and the tower's foot.
    await this.deps.drops.collectNear(first, context.signal)
    return { dug, left, missing: 0, leavesCut: built.leavesCut ?? 0, aborted }
  }

  /** Digs one log from the tower, adding a block to the tower while it is still out of reach. */
  private async cutFromTower(
    log: Position,
    tower: Parameters<TowerBuilder['pillarOnce']>[0],
    scaffolder: TowerBuilder,
    context: SkillContext,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < TOWER_TRIES; attempt += 1) {
      const dug = await this.deps.digger.dig(log, context.signal)
      if (dug.ok) return true
      if (dug.error.reason !== 'out_of_reach') return false
      const carried = countItems(this.deps.inventory.snapshot()).get(SCAFFOLD_BLOCK) ?? 0
      if (tower.cells.length >= MAX_TOWER_HEIGHT || carried < 1) return false
      const higher = await scaffolder.pillarOnce(tower, context.signal)
      if (!higher.ok) return false
    }
    return false
  }

  /** Breaks one log from close by: walks within reach first, and closer when the dig says it is too far. */
  private async cut(
    log: Position,
    context: SkillContext,
  ): Promise<'dug' | 'left' | 'high' | 'aborted'> {
    let outOfReach = false
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
      outOfReach = true
    }
    return outOfReach ? 'high' : 'left'
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
        if (
          Math.abs(next.x - base.x) > HORIZONTAL_LIMIT ||
          Math.abs(next.z - base.z) > HORIZONTAL_LIMIT
        )
          continue
        if (next.y < base.y || next.y > base.y + VERTICAL_LIMIT) continue
        seen.add(key(next))
        if (this.deps.blocks.blockAt(next) === logName) queue.push(next)
      }
    }
    return found.sort((a, b) => a.y - b.y)
  }
}
