import type { AreaGuard } from '../../core/area-guard.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Digger } from '../../core/digger.port.js'
import type { Locomotion } from '../../core/locomotion.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Placer } from '../../core/placer.port.js'
import type { Position } from '../../core/position.types.js'
import { EYE_HEIGHT } from '../../core/reach.js'
import { err, ok, type Result } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import { sleep } from '../../core/sleep.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { DropCollector } from '../gathering/drop-collector.js'
import { cellKey, WORK_REACH } from './standing-spot.js'

const POLL_MS = 50
const JUMP_POLLS = 24
const SETTLE_POLLS = 30
/** Tries for one block of the tower before giving up. */
const PILLAR_TRIES = 3
const SEARCH_RADIUS = 3
/** How far below a target the ground is looked for. */
const GROUND_SEARCH = 14
const FLUIDS = new Set(['water', 'lava'])
/** Walking is cheap next to digging: a column with leaves in it loses to a clear one that is a few blocks farther. */
const LEAF_COST = 3
const cellKeyOf = (cell: Position): string =>
  `${String(cell.x)},${String(cell.y)},${String(cell.z)}`

export interface TowerPlan {
  /** The ground cell the tower starts in: the bot stands in it, and the first scaffold block goes into it. */
  readonly base: Position
  /** How many blocks high. */
  readonly height: number
  /** Cells of the tower's column that hold something in the way (a leaf) and are dug before the bot climbs into them. */
  readonly clear?: readonly Position[]
  /** Cells above the planned height may be dug too when the tower has to grow (a leaf of the same tree). */
  readonly mayCut?: (cell: Position) => boolean
}

export interface Tower {
  readonly base: Position
  readonly block: string
  /** Cells holding a scaffold block, from the bottom up. */
  readonly cells: Position[]
  /** Cells that may be dug out of the way ahead of the bot (`TowerPlan.clear`), as `x,y,z` keys. */
  readonly clear?: ReadonlySet<string>
  /** Any other cell of the column that may be dug when the tower grows past its plan. */
  readonly mayCut?: (cell: Position) => boolean
  /** How many of them were dug. */
  leavesCut?: number
}

export interface TowerRequest {
  readonly target: Position
  readonly from: Position
  /** Cells still to be built: a tower must not stand in one. */
  readonly reserved: ReadonlySet<string>
  readonly maxHeight: number
  /** Cells to keep out of when there is a choice (the inside of the building). */
  readonly avoid?: (cell: Position) => boolean
  /**
   * A solid cell that may stand in the tower's column anyway, because it will be dug first (a leaf of the tree the
   * tower is for). Without it every cell above the ground must be free.
   */
  readonly passable?: (cell: Position) => boolean
  /** A column that needs more of its cells dug than this is not used. */
  readonly maxClear?: number
}

export interface ScaffolderDeps {
  readonly blocks: BlockScanner
  readonly placer: Placer
  readonly digger: Digger
  readonly locomotion: Locomotion
  readonly navigator: Navigator
  readonly vitals: VitalsReader
  readonly guard: AreaGuard
  readonly drops: DropCollector
  readonly scheduler: Scheduler
}

export interface ScaffoldFailure {
  readonly reason: 'aborted' | 'unreachable' | 'jump_failed' | 'place_failed' | 'not_connected'
  readonly message: string
}

/**
 * Pillars the bot up to reach what is too high for the ground: it jumps and puts a block under its own feet, one at a
 * time, and takes the tower down again from the top when it is done (breaking the block underfoot, so it never falls
 * more than one block and is never left stranded). The tower stands beside the work, outside the building when it can,
 * never in a cell that is still to be built, never in a protected area, and never near lava.
 */
export class Scaffolder {
  constructor(private readonly deps: ScaffolderDeps) {}

  /** Where and how high a tower has to be to reach the target. Undefined when there is no safe place for one. */
  plan(request: TowerRequest): TowerPlan | undefined {
    const tx = Math.floor(request.target.x)
    const ty = Math.floor(request.target.y)
    const tz = Math.floor(request.target.z)
    let best: { plan: TowerPlan; score: number } | undefined
    for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += 1)
      for (let dz = -SEARCH_RADIUS; dz <= SEARCH_RADIUS; dz += 1) {
        if (dx === 0 && dz === 0) continue
        const ground = this.groundFeet({ x: tx + dx, y: ty, z: tz + dz }, request.passable)
        if (ground === undefined) continue
        const height = this.heightFor(ground, request.target, request.maxHeight)
        if (height === undefined || height < 1) continue
        const clear: Position[] = []
        if (!this.columnIsFree(ground, height, request, clear)) continue
        const walk = Math.hypot(ground.x + 0.5 - request.from.x, ground.z + 0.5 - request.from.z)
        const inside = request.avoid?.(ground) === true ? 100 : 0
        const score = height * 10 + walk + inside + clear.length * LEAF_COST
        if (best === undefined || score < best.score)
          best = {
            plan: {
              base: ground,
              height,
              ...(clear.length === 0 ? {} : { clear }),
              ...(request.passable === undefined ? {} : { mayCut: request.passable }),
            },
            score,
          }
      }
    return best?.plan
  }

  /** Walks to the base and builds the tower, one block at a time. */
  async raise(
    plan: TowerPlan,
    block: string,
    signal: AbortSignal,
  ): Promise<Result<Tower, ScaffoldFailure & { tower: Tower }>> {
    const { deps } = this
    const tower: Tower = {
      base: plan.base,
      block,
      cells: [],
      clear: new Set((plan.clear ?? []).map(cellKeyOf)),
      ...(plan.mayCut === undefined ? {} : { mayCut: plan.mayCut }),
      leavesCut: 0,
    }
    const walked = await deps.navigator.goToPosition(
      { x: plan.base.x + 0.5, y: plan.base.y, z: plan.base.z + 0.5 },
      0.4,
      { signal },
    )
    if (!walked.ok)
      return err({
        reason: walked.error.reason === 'aborted' ? 'aborted' : 'unreachable',
        message: `Could not get to the foot of the tower: ${walked.error.message}`,
        tower,
      })
    for (let level = 0; level < plan.height; level += 1) {
      const done = await this.pillarOnce(tower, signal)
      if (!done.ok) return err({ ...done.error, tower })
    }
    return ok(tower)
  }

  /** One more block on top of the tower. */
  async pillarOnce(tower: Tower, signal: AbortSignal): Promise<Result<void, ScaffoldFailure>> {
    const { deps } = this
    const level = tower.cells.length
    const cell = { x: tower.base.x, y: tower.base.y + level, z: tower.base.z }
    const below = { x: cell.x, y: cell.y - 1, z: cell.z }
    let problem: ScaffoldFailure = { reason: 'place_failed', message: 'the block did not go down' }
    const cleared = await this.clearAbove(tower, cell, signal)
    if (!cleared.ok) return cleared
    for (let attempt = 0; attempt < PILLAR_TRIES; attempt += 1) {
      if (signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
      const start = deps.vitals.read()?.position
      if (start === undefined)
        return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
      deps.locomotion.setJump(true)
      const airborne = await this.untilY(cell.y + 1, signal)
      if (!airborne) {
        deps.locomotion.setJump(false)
        problem = { reason: 'jump_failed', message: 'the bot could not jump' }
        await sleep(deps.scheduler, 300, signal)
        continue
      }
      const placed = await deps.placer.placeAgainst(tower.block, below, { x: 0, y: 1, z: 0 })
      deps.locomotion.setJump(false)
      if (!placed.ok) {
        problem = { reason: 'place_failed', message: placed.error.message }
        await this.settleOn(cell.y, signal)
        continue
      }
      if (await this.blockAppears(cell, tower.block, signal)) {
        tower.cells.push(cell)
        if (await this.settleOn(cell.y + 1, signal)) return ok(undefined)
        problem = { reason: 'jump_failed', message: 'the bot did not land on the new block' }
      }
    }
    return err(problem)
  }

  /**
   * Takes the tower down from the top and picks the blocks up. It always tries, whatever happened before (the signal
   * that cancelled the work must not keep the bot from coming down). Returns the cells that could not be removed.
   */
  async lower(tower: Tower): Promise<Position[]> {
    const { deps } = this
    const never = new AbortController().signal
    const left: Position[] = []
    for (const cell of [...tower.cells].reverse()) {
      if (this.nameAt(cell) === undefined || this.nameAt(cell) === 'air') continue
      const dug = await deps.digger.dig(cell, never)
      if (!dug.ok) {
        left.push(cell)
        continue
      }
      await this.settleOn(cell.y, never)
    }
    tower.cells.length = 0
    await deps.drops.collectNear(
      { x: tower.base.x + 0.5, y: tower.base.y, z: tower.base.z + 0.5 },
      never,
    )
    return left
  }

  /** Digs what stands in the two cells above the one the bot is about to jump into, when the plan said it may. */
  private async clearAbove(
    tower: Tower,
    cell: Position,
    signal: AbortSignal,
  ): Promise<Result<void, ScaffoldFailure>> {
    for (const up of [1, 2, 3]) {
      const above = { x: cell.x, y: cell.y + up, z: cell.z }
      if (tower.clear?.has(cellKeyOf(above)) !== true && tower.mayCut?.(above) !== true) continue
      const name = this.nameAt(above)
      if (name === undefined || name === 'air') continue
      const dug = await this.deps.digger.dig(above, signal)
      if (!dug.ok)
        return err({
          reason: dug.error.reason === 'aborted' ? 'aborted' : 'place_failed',
          message: `Could not dig ${name} out of the way: ${dug.error.message}`,
        })
      tower.leavesCut = (tower.leavesCut ?? 0) + 1
    }
    return ok(undefined)
  }

  private nameAt(cell: Position): string | undefined {
    return this.deps.blocks.blockAt(cell)
  }

  /** The feet cell of the ground in a column: solid below, two free cells above. */
  private groundFeet(
    column: Position,
    passable?: (cell: Position) => boolean,
  ): Position | undefined {
    const { blocks } = this.deps
    for (let y = column.y; y >= column.y - GROUND_SEARCH; y -= 1) {
      const feet = { x: column.x, y, z: column.z }
      if (blocks.isSolid({ ...feet, y: y - 1 }) !== true) continue
      // A leaf is not ground: the search goes on down through the canopy to the real ground.
      if (passable?.({ ...feet, y: y - 1 }) === true) continue
      if (blocks.isSolid(feet) !== false || blocks.isSolid({ ...feet, y: y + 1 }) !== false)
        return undefined
      const name = blocks.blockAt(feet)
      return name !== undefined && FLUIDS.has(name) ? undefined : feet
    }
    return undefined
  }

  /** The smallest tower height from which the target is within reach, or undefined when the limit is too low. */
  private heightFor(ground: Position, target: Position, maxHeight: number): number | undefined {
    const horizontal = Math.hypot(
      ground.x + 0.5 - (Math.floor(target.x) + 0.5),
      ground.z + 0.5 - (Math.floor(target.z) + 0.5),
    )
    for (let height = 0; height <= maxHeight; height += 1) {
      const eyes = ground.y + height + EYE_HEIGHT
      const vertical = eyes - (Math.floor(target.y) + 0.5)
      if (Math.hypot(horizontal, vertical) <= WORK_REACH) return height
    }
    return undefined
  }

  /** Room for the tower and the bot on it, no protected cells, no lava around, nothing that is still to be built. */
  private columnIsFree(
    ground: Position,
    height: number,
    request: TowerRequest,
    clear: Position[],
  ): boolean {
    const { blocks, guard } = this.deps
    for (let level = 0; level <= height + 1; level += 1) {
      const cell = { x: ground.x, y: ground.y + level, z: ground.z }
      if (request.reserved.has(cellKey(cell))) return false
      if (guard.protectedAt(cell) !== undefined) return false
      if (level >= 1 && blocks.isSolid(cell) !== false) {
        if (request.passable?.(cell) !== true) return false
        clear.push(cell)
        if (clear.length > (request.maxClear ?? 0)) return false
      }
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const)
        if (blocks.blockAt({ x: cell.x + dx, y: cell.y, z: cell.z + dz }) === 'lava') return false
    }
    return true
  }

  /** Waits until the bot's feet are at least at `y` (it is jumping up). */
  private async untilY(y: number, signal: AbortSignal): Promise<boolean> {
    for (let poll = 0; poll < JUMP_POLLS; poll += 1) {
      if ((this.deps.vitals.read()?.position.y ?? -Infinity) >= y) return true
      if (signal.aborted) return false
      await sleep(this.deps.scheduler, POLL_MS, signal)
    }
    return false
  }

  /** Waits until the bot stands with its feet at `y`. */
  private async settleOn(y: number, signal: AbortSignal): Promise<boolean> {
    for (let poll = 0; poll < SETTLE_POLLS; poll += 1) {
      const now = this.deps.vitals.read()?.position.y ?? Infinity
      if (Math.abs(now - y) < 0.2) return true
      if (signal.aborted) return false
      await sleep(this.deps.scheduler, POLL_MS, signal)
    }
    return false
  }

  private async blockAppears(cell: Position, block: string, signal: AbortSignal): Promise<boolean> {
    for (let poll = 0; poll < SETTLE_POLLS; poll += 1) {
      if (this.deps.blocks.blockAt(cell) === block) return true
      if (signal.aborted) return false
      await sleep(this.deps.scheduler, POLL_MS, signal)
    }
    return false
  }
}
