import type { AreaGuard } from '../../core/area-guard.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Digger } from '../../core/digger.port.js'
import { countItems, describeItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Placer } from '../../core/placer.port.js'
import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { SkillContext, SkillResult } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { InventoryFullKind } from '../../state/storage-policy.js'
import type { DropCollector } from '../gathering/drop-collector.js'
import type { InventoryFullHandler } from '../storage/inventory-full-handler.js'
import { isOpenAir, isPlanned, isReplaceable } from './block-match.js'
import type { Hazard, HazardReason, HazardRule } from './hazard-rule.js'
import type { SupplyCrafter } from './crafting-supplies.js'
import type { Scaffolder, Tower } from './scaffolder.js'
import type { SpoilDiscarder } from './spoil-discarder.js'
import type { SiteSafety } from './site-safety.js'
import { cellKey, type StandingSpotChooser } from './standing-spot.js'
import type { WorkPlan, WorkStep } from './work-plan.types.js'

/** A step is tried this many times before it counts as failed. */
const MAX_ATTEMPTS = 3
/** This many failed steps in a row mean something is wrong with the whole job. */
const MAX_FAILURES_IN_A_ROW = 5
const CONFIRM_POLL_MS = 100
const CONFIRM_POLLS = 15
const TORCH = 'torch'
/** How many torches to make at once when they run out. */
const TORCH_BATCH = 8
/** Tools that can be crafted, cheapest first (gold and netherite are not made for a dig). */
const CRAFTABLE_TIERS = ['wooden', 'stone', 'iron', 'diamond']
/** The plan is checked against the world this many times (the second look is the verification pass). */
const ROUNDS = 2
/** Blocks that stay in a dug opening (a ladder, a torch): the cell still counts as dug. */
const PLACED_IN_OPENINGS = new Set(['ladder', 'torch', 'wall_torch'])
const ORE = /(_ore|ancient_debris)$/
/** From the ground the bot reaches about this far above the cell it stands in (eye height plus reach, at arm's length). */
const GROUND_REACH = 4.8
const GROUND_REACH_ROWS = 5
const SAMPLE = 10

export interface PlanOptions {
  /** Break natural blocks that are in the way of a placement, instead of refusing. Protected areas are never broken. */
  readonly clearObstacles: boolean
  /** What to do when the inventory fills up while breaking; the standing policy when undefined. */
  readonly onInventoryFull?: InventoryFullKind | undefined
  /** What to do with the spoil when the inventory is full: the standing storage policy (default), or throw the junk away. */
  readonly spoil?: 'storage' | 'discard_junk' | undefined
  /** Pillar up with this block to reach what is too high for the ground; without it such steps fail. */
  readonly scaffold?: { readonly block: string; readonly maxHeight: number } | undefined
}

export interface PlanPreview {
  readonly steps: number
  readonly toPlace: number
  readonly toBreak: number
  /** Steps whose result is already in the world. */
  readonly alreadyDone: number
  /** Blocks the placements need, and what the bot carries. */
  readonly needs: readonly ItemCount[]
  readonly missing: readonly ItemCount[]
  /** Torches the lighting steps may use (never counted as missing). */
  readonly torchesWanted: number
  /** Cells holding something else that is in the way (empty when obstacles are cleared). */
  readonly blocked: readonly Position[]
  readonly blockedCount: number
  /** The protected area the plan touches, if any. */
  readonly protectedArea: string | undefined
  readonly hazards: readonly string[]
  /**
   * Steps that are too high to reach from the ground, and the tower height (in scaffold blocks, already counted in
   * `needs`) an estimate says they take. Undefined when nothing is too high or scaffolding is off.
   */
  readonly scaffold:
    { readonly steps: number; readonly height: number; readonly block: string } | undefined
}

/** A chain of cells (a tunnel, a side branch, an ore vein) that stopped before its end. */
export interface EndedBranch {
  readonly branch: string
  readonly reason: HazardReason | 'blocked_by_earlier'
  /** Where it stopped: the fluid, the cavity, the spawner, and so on. */
  readonly at: Position | undefined
  /** How many cells of it were left undone. */
  readonly skipped: number
}

export interface PlanOutcome {
  readonly steps: number
  readonly placed: number
  readonly broken: number
  readonly lights: number
  readonly alreadyDone: number
  readonly used: readonly ItemCount[]
  /** Chains that ended early, with why and where. */
  readonly ended: readonly EndedBranch[]
}

export interface PlanExecutorDeps {
  readonly blocks: BlockScanner
  readonly placer: Placer
  readonly digger: Digger
  readonly navigator: Navigator
  readonly inventory: InventoryReader
  readonly vitals: VitalsReader
  readonly guard: AreaGuard
  readonly drops: DropCollector
  readonly spots: StandingSpotChooser
  readonly safety: SiteSafety
  readonly scheduler: Scheduler
  /** Decides what happens when the inventory is full; without it the plan stops. */
  readonly full?: InventoryFullHandler
  /** Lets the bot pillar up; without it steps beyond the reach from the ground fail. */
  readonly scaffolder?: Scaffolder
  /** The rule that ends a dig at lava, water, cavities, and the like (used by plans that ask for it). */
  readonly hazard?: HazardRule
  /** Throws junk away when the inventory is full and the request said to (`spoil: discard_junk`). */
  readonly discarder?: SpoilDiscarder
  /** Crafts torches and a spare pickaxe when they run out. */
  readonly supplies?: SupplyCrafter
}

const failure = (
  reason: string,
  message: string,
  progress: Progress,
  detail: Record<string, unknown> = {},
) =>
  err({
    reason,
    message: `${message} Placed ${String(progress.placed)}, broke ${String(progress.broken)} so far.`,
    detail: { placed: progress.placed, broken: progress.broken, ...detail },
  })

interface Progress {
  placed: number
  broken: number
  lights: number
  used: Map<string, number>
}

/**
 * Carries out a `WorkPlan`: walks to a place within reach of each cell, places blocks against what supports them
 * (taking the first step that has a support, so a wall grows from the ground up whatever order the provider lists),
 * breaks what has to go and picks up the drops, and lights dark spots. Everything already in the world is skipped,
 * so a plan that was interrupted simply continues when it is run again. A second look at the end verifies the result.
 */
export class PlanExecutor {
  constructor(private readonly deps: PlanExecutorDeps) {}

  /** What running the plan would take and touch, without doing anything. */
  preview(plan: WorkPlan, options: PlanOptions): PlanPreview {
    const { deps } = this
    const needs = new Map<string, number>()
    const blocked: Position[] = []
    let toPlace = 0
    let toBreak = 0
    let done = 0
    let torches = 0
    let requiredTorches = 0
    let protectedArea: string | undefined
    const dugBySteps = new Set(
      plan.steps.filter((step) => step.kind === 'break').map((step) => cellKey(step.at)),
    )
    for (const step of plan.steps) {
      protectedArea ??= deps.guard.protectedAt(step.at)?.label
      const found = deps.blocks.blockAt(step.at)
      if (step.kind === 'light') {
        torches += 1
        if (step.required === true) requiredTorches += 1
        continue
      }
      if (step.kind === 'break') {
        if (isOpenAir(found)) done += 1
        else toBreak += 1
        continue
      }
      if (step.kind === 'seal') {
        // Any solid block satisfies a seal step; it is not counted as blocked when something else already fills it.
        // Like a torch, the material is never counted as missing: sealing is a best-effort backfill, not a hard
        // requirement, and an otherwise-fine dig must not be refused up front for want of a spare block.
        if (!isOpenAir(found)) done += 1
        else toPlace += 1
        continue
      }
      if (isPlanned(step.block, found)) {
        done += 1
        continue
      }
      toPlace += 1
      needs.set(step.block, (needs.get(step.block) ?? 0) + 1)
      if (found !== undefined && !isReplaceable(found) && !dugBySteps.has(cellKey(step.at))) {
        if (options.clearObstacles) toBreak += 1
        else blocked.push(step.at)
      }
    }
    if (requiredTorches > 0) needs.set(TORCH, (needs.get(TORCH) ?? 0) + requiredTorches)
    const scaffold = this.estimateScaffold(plan, options)
    if (scaffold !== undefined)
      needs.set(scaffold.block, (needs.get(scaffold.block) ?? 0) + scaffold.height)
    const have = countItems(deps.inventory.snapshot())
    const missing: ItemCount[] = []
    for (const [name, count] of needs) {
      const short = count - (have.get(name) ?? 0)
      if (short > 0) missing.push({ name, count: short })
    }
    return {
      steps: plan.steps.length,
      toPlace,
      toBreak,
      alreadyDone: done,
      needs: [...needs].map(([name, count]) => ({ name, count })),
      missing,
      torchesWanted: torches,
      blocked: blocked.slice(0, SAMPLE),
      blockedCount: blocked.length,
      protectedArea,
      hazards: plan.hazards === 'end_branch' ? [] : deps.safety.hazards(plan),
      scaffold,
    }
  }

  async run(
    plan: WorkPlan,
    options: PlanOptions,
    context: SkillContext,
  ): Promise<SkillResult<PlanOutcome>> {
    const { deps } = this
    if (deps.inventory.snapshot() === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })

    const preview = this.preview(plan, options)
    if (preview.protectedArea !== undefined)
      return err({
        reason: 'protected_area',
        message: `The plan reaches into the protected area "${preview.protectedArea}". Nothing was changed.`,
      })
    if (preview.hazards.length > 0)
      return err({
        reason: 'unsafe_site',
        message: `The site is not safe: ${preview.hazards.join('; ')}. Nothing was changed.`,
        detail: { hazards: preview.hazards },
      })
    if (preview.blockedCount > 0)
      return err({
        reason: 'blocked_cells',
        message: `${String(preview.blockedCount)} cell(s) are occupied by other blocks (for example at ${this.where(preview.blocked[0])}). Choose another spot, or allow clearing obstacles. Nothing was changed.`,
        detail: { blocked: preview.blocked, blockedCount: preview.blockedCount },
      })
    if (preview.missing.length > 0)
      return err({
        reason: 'missing_materials',
        message: `Missing ${describeItems(preview.missing)}. Nothing was changed.`,
        detail: { missing: preview.missing, needs: preview.needs },
      })

    const progress: Progress = { placed: 0, broken: 0, lights: 0, used: new Map() }
    const failed = new Map<string, string>()
    const attempts = new Map<StepKey, number>()
    const fullSession = deps.full?.begin(options.onInventoryFull)
    let inARow = 0
    const ended = new Map<string, EndedBranch>()
    const skipped = new Set<StepKey>()
    const veinSeen = new Set<string>()
    this.planCells = new Set(plan.steps.map((step) => cellKey(step.at)))
    this.order = new Map(plan.steps.map((step, index) => [cellKey(step.at), index]))
    this.dug = new Set()

    for (let round = 0; round < ROUNDS; round += 1) {
      const pending = plan.steps.filter(
        (step) => !this.satisfied(step) && !failed.has(keyOf(step)) && !skipped.has(keyOf(step)),
      )
      if (pending.length === 0) break
      if (round === 0) context.progress(`Working on ${plan.name}: ${String(pending.length)} steps`)
      /** Steps that are too high for the ground: they wait for a tower. */
      const high: WorkStep[] = []
      while (pending.length > 0) {
        if (context.signal.aborted) return failure('aborted', 'Cancelled.', progress)
        const step = this.next(pending)
        if (
          step === undefined &&
          pending.every((s) => s.kind === 'break' && s.needs !== undefined)
        ) {
          // What is left starts from a cell that never got dug (the tunnel it leaves ended early).
          for (const s of pending) {
            this.recordEnded(
              ended,
              s.kind === 'break' ? (s.branch ?? 'plan') : 'plan',
              'blocked_by_earlier',
              s.kind === 'break' ? s.needs : undefined,
            )
            skipped.add(keyOf(s))
          }
          pending.length = 0
          break
        }
        if (step === undefined && this.scaffolding(options)) {
          // What is left needs something above the ground to be built first.
          high.push(...pending)
          pending.length = 0
          break
        }
        if (step === undefined)
          return failure(
            'unsupported_steps',
            `${String(pending.length)} blocks have nothing to be placed against (floating in the air).`,
            progress,
            { remaining: pending.length },
          )
        pending.splice(pending.indexOf(step), 1)
        if (this.satisfied(step)) continue

        const outcome = await this.perform(
          plan,
          step,
          [...pending, ...high],
          options,
          fullSession,
          progress,
          context,
        )
        if (outcome.kind === 'stop') return outcome.result
        if (outcome.kind === 'high') {
          high.push(step)
          continue
        }
        if (outcome.kind === 'end') {
          this.endChain(step, outcome.hazard, [pending, high], ended, skipped)
          inARow = 0
          continue
        }
        if (outcome.kind === 'retry') {
          const tried = (attempts.get(keyOf(step)) ?? 0) + 1
          attempts.set(keyOf(step), tried)
          if (tried < MAX_ATTEMPTS) pending.push(step)
          else if (step.kind === 'break' && step.optional === true) skipped.add(keyOf(step))
          else {
            failed.set(keyOf(step), outcome.why)
            inARow += 1
          }
          if (inARow >= MAX_FAILURES_IN_A_ROW)
            return failure(
              'stuck',
              `Several steps in a row failed; the last reason: ${outcome.why}.`,
              progress,
              { failedSteps: failed.size },
            )
        } else {
          inARow = 0
          // Ore that touches a dug cell is mined too, vein by vein.
          if (step.kind === 'break' && plan.veins !== undefined)
            pending.unshift(...this.veinSteps(step.at, plan.veins.maxSize, veinSeen))
        }
        context.progress(`Placed ${String(progress.placed)}, broke ${String(progress.broken)}`)
      }
      if (high.length > 0) {
        const stopped = await this.towerPass(
          plan,
          high,
          options,
          progress,
          failed,
          attempts,
          context,
        )
        if (stopped !== undefined) return stopped
      }
    }

    if (failed.size > 0) {
      const reasons = [...new Set(failed.values())].join('; ')
      return failure(
        'incomplete',
        `${String(failed.size)} step(s) could not be done (${reasons}). Run it again to try the rest.`,
        progress,
        {
          failedSteps: failed.size,
          reasons: [...new Set(failed.values())],
          ended: [...ended.values()],
        },
      )
    }
    // Lighting and sealing are a courtesy (no torches, no torch; nothing to backfill with, left open), so neither
    // is part of what must hold.
    const stillOpen = plan.steps.filter(
      (step) =>
        step.kind !== 'light' &&
        step.kind !== 'seal' &&
        !skipped.has(keyOf(step)) &&
        !this.satisfied(step),
    ).length
    if (stillOpen > 0)
      return failure(
        'verification_failed',
        `${String(stillOpen)} step(s) did not hold when checked at the end. Run it again to fix them.`,
        progress,
        { stillOpen },
      )
    return ok({
      steps: plan.steps.length,
      placed: progress.placed,
      broken: progress.broken,
      lights: progress.lights,
      alreadyDone: preview.alreadyDone,
      used: [...progress.used].map(([name, count]) => ({ name, count })),
      ended: [...ended.values()],
    })
  }

  /**
   * How high a tower the steps above the reach from the ground need, from the plan alone: the lowest cell is taken as
   * the ground, and the reach is about 4.8 blocks above it. The run works it out exactly.
   */
  private estimateScaffold(plan: WorkPlan, options: PlanOptions): PlanPreview['scaffold'] {
    if (
      options.scaffold === undefined ||
      this.deps.scaffolder === undefined ||
      options.scaffold.maxHeight < 1
    )
      return undefined
    const ground = Math.min(...plan.steps.map((step) => step.at.y))
    const high = plan.steps.filter((step) => step.at.y - ground > GROUND_REACH_ROWS)
    if (high.length === 0) return undefined
    const top = Math.max(...high.map((step) => step.at.y - ground))
    const height = Math.min(options.scaffold.maxHeight, Math.ceil(top - GROUND_REACH))
    return { steps: high.length, height, block: options.scaffold.block }
  }

  /** The first pending step that can be done now: breaks and lights always, placements once something supports them. */
  private next(pending: readonly WorkStep[]): WorkStep | undefined {
    return pending.find((step) => this.available(step))
  }

  /** Every cell the running plan works on (used to tell ore veins from the plan), and each cell's place in the order. */
  private planCells: ReadonlySet<string> = new Set()
  private order: ReadonlyMap<string, number> = new Map()
  /** Cells broken during this run. */
  private dug = new Set<string>()

  /** Whether a step can be done right now. */
  private available(step: WorkStep): boolean {
    switch (step.kind) {
      case 'place':
        return this.support(step.at, step.against) !== undefined
      case 'break':
        return step.needs === undefined || this.isOpening(this.deps.blocks.blockAt(step.needs))
      case 'light':
      case 'seal':
        return true
    }
  }

  /** A dug cell: open air, or one with a torch or ladder standing in it. */
  private isOpening(name: string | undefined): boolean {
    return isOpenAir(name) || (name !== undefined && PLACED_IN_OPENINGS.has(name))
  }

  /** Notes that a chain stopped early, once per chain and reason, counting the cells it left. */
  private recordEnded(
    ended: Map<string, EndedBranch>,
    branch: string,
    reason: EndedBranch['reason'],
    at: Position | undefined,
  ): void {
    const label = branch.startsWith('vein@') ? 'vein' : branch
    const key = `${label}|${reason}|${label === 'vein' ? '' : cellKey(at ?? { x: 0, y: 0, z: 0 })}`
    const found = ended.get(key)
    ended.set(key, {
      branch: label,
      reason,
      at: found?.at ?? at,
      skipped: (found?.skipped ?? 0) + 1,
    })
  }

  /** A hazard ends the chain of the step that met it: the step and the rest of its chain are dropped. */
  private endChain(
    step: WorkStep,
    hazard: Hazard,
    lists: readonly WorkStep[][],
    ended: Map<string, EndedBranch>,
    skipped: Set<StepKey>,
  ): void {
    const branch = step.kind === 'break' ? (step.branch ?? keyOf(step)) : keyOf(step)
    skipped.add(keyOf(step))
    this.recordEnded(ended, branch, hazard.reason, hazard.at)
    for (const list of lists)
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const other = list[i]
        if (other?.branch !== branch) continue
        skipped.add(keyOf(other))
        this.recordEnded(ended, branch, hazard.reason, hazard.at)
        list.splice(i, 1)
      }
  }

  /** Ore touching a dug cell, followed vein by vein (neighbours in all directions, up to `maxSize` blocks). */
  private veinSteps(dug: Position, maxSize: number, seen: Set<string>): WorkStep[] {
    const { blocks, guard } = this.deps
    const found: WorkStep[] = []
    const queue: Position[] = [dug]
    while (queue.length > 0 && found.length < maxSize) {
      const current = queue.shift()
      if (current === undefined) break
      for (let dx = -1; dx <= 1; dx += 1)
        for (let dy = -1; dy <= 1; dy += 1)
          for (let dz = -1; dz <= 1; dz += 1) {
            const cell = { x: current.x + dx, y: current.y + dy, z: current.z + dz }
            const key = cellKey(cell)
            if (seen.has(key) || this.planCells.has(key)) continue
            const name = blocks.blockAt(cell)
            if (name === undefined || !ORE.test(name) || guard.protectedAt(cell) !== undefined)
              continue
            seen.add(key)
            found.push({ kind: 'break', at: cell, branch: `vein@${cellKey(dug)}`, optional: true })
            queue.push(cell)
          }
    }
    return found
  }

  private scaffolding(options: PlanOptions): boolean {
    return (
      this.deps.scaffolder !== undefined &&
      options.scaffold !== undefined &&
      options.scaffold.maxHeight >= 1
    )
  }

  /**
   * Builds the steps that are too high for the ground from a scaffold tower: pillar up beside the lowest of them, do
   * everything within reach from up there (raising the tower a block at a time while something higher is left), and
   * always take the tower down again, even when cancelled or failing.
   */
  private async towerPass(
    plan: WorkPlan,
    high: readonly WorkStep[],
    options: PlanOptions,
    progress: Progress,
    failed: Map<string, string>,
    attempts: Map<StepKey, number>,
    context: SkillContext,
  ): Promise<SkillResult<PlanOutcome> | undefined> {
    const { deps } = this
    const scaffolder = deps.scaffolder
    const config = options.scaffold
    if (scaffolder === undefined || config === undefined) return undefined
    const open = (): WorkStep[] =>
      high.filter((step) => !this.satisfied(step) && !failed.has(keyOf(step)))
    let remaining = open()
    while (remaining.length > 0) {
      if (context.signal.aborted) return failure('aborted', 'Cancelled.', progress)
      remaining.sort((a, b) => a.at.y - b.at.y)
      const target = remaining[0]
      const here = deps.vitals.read()?.position
      if (target === undefined || here === undefined)
        return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
      const reserved = new Set(
        plan.steps
          .filter((s) => s.kind === 'place' && !this.satisfied(s))
          .map((s) => cellKey(s.at)),
      )
      const tower = scaffolder.plan({
        target: target.at,
        from: here,
        reserved,
        maxHeight: config.maxHeight,
        avoid: this.avoidOf(plan),
      })
      if (tower === undefined) {
        for (const step of remaining)
          failed.set(keyOf(step), `no safe place for a scaffold tower near ${this.where(step.at)}`)
        return undefined
      }
      const carried = countItems(deps.inventory.snapshot()).get(config.block) ?? 0
      if (carried < tower.height)
        return failure(
          'missing_materials',
          `The scaffold needs ${String(tower.height)} ${config.block} and the bot has ${String(carried)}.`,
          progress,
          { missing: [{ name: config.block, count: tower.height - carried }] },
        )

      const raised = await scaffolder.raise(tower, config.block, context.signal)
      const built = raised.ok ? raised.value : raised.error.tower
      try {
        if (!raised.ok) {
          if (raised.error.reason === 'aborted') return failure('aborted', 'Cancelled.', progress)
          failed.set(keyOf(target), `the scaffold tower failed: ${raised.error.message}`)
        } else {
          const stopped = await this.workFromTower(
            built,
            remaining,
            options,
            progress,
            failed,
            attempts,
            context,
          )
          if (stopped !== undefined) return stopped
        }
      } finally {
        const left = await scaffolder.lower(built)
        if (left.length > 0)
          context.progress(`${String(left.length)} scaffold block(s) could not be taken down`)
      }
      remaining = open()
    }
    return undefined
  }

  /** With the bot on top of the tower: does what is within reach, raising the tower while higher steps remain. */
  private async workFromTower(
    tower: Tower,
    remaining: readonly WorkStep[],
    options: PlanOptions,
    progress: Progress,
    failed: Map<string, string>,
    attempts: Map<StepKey, number>,
    context: SkillContext,
  ): Promise<SkillResult<PlanOutcome> | undefined> {
    const { deps } = this
    const scaffolder = deps.scaffolder
    const config = options.scaffold
    if (scaffolder === undefined || config === undefined) return undefined
    for (;;) {
      if (context.signal.aborted) return failure('aborted', 'Cancelled.', progress)
      const feet = deps.vitals.read()?.position
      if (feet === undefined)
        return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
      const todo = remaining.filter((s) => !this.satisfied(s) && !failed.has(keyOf(s)))
      const doable = todo.filter(
        (s) =>
          deps.spots.inReach(feet, s.at) &&
          (s.kind !== 'place' || this.support(s.at) !== undefined),
      )
      const step = doable[0]
      if (step === undefined) {
        const higher = todo.some((s) => s.at.y > Math.floor(feet.y))
        const room = tower.cells.length < config.maxHeight
        const carried = countItems(deps.inventory.snapshot()).get(config.block) ?? 0
        if (!higher || !room || carried === 0) return undefined
        const more = await scaffolder.pillarOnce(tower, context.signal)
        if (!more.ok) {
          if (more.error.reason === 'aborted') return failure('aborted', 'Cancelled.', progress)
          return undefined
        }
        continue
      }
      const outcome =
        step.kind === 'place'
          ? await this.place(step.at, step.block, options, progress, context, step.against)
          : step.kind === 'break'
            ? await this.breakCell(step.at, undefined, progress, context, options)
            : ({ kind: 'done' } as Outcome)
      if (outcome.kind === 'stop') return outcome.result
      if (outcome.kind === 'retry') {
        const tried = (attempts.get(keyOf(step)) ?? 0) + 1
        attempts.set(keyOf(step), tried)
        if (tried >= MAX_ATTEMPTS) failed.set(keyOf(step), outcome.why)
      }
    }
  }

  private satisfied(step: WorkStep): boolean {
    const found = this.deps.blocks.blockAt(step.at)
    switch (step.kind) {
      case 'place':
        return isPlanned(step.block, found)
      case 'break':
        return this.isOpening(found)
      case 'light':
        return !this.deps.safety.needsTorch(step.at, step.minLight, step.spacing)
      case 'seal':
        return !isOpenAir(found)
    }
  }

  /** A neighbouring solid block to place against, preferring the one below. */
  private support(
    at: Position,
    against?: Position,
  ): { reference: Position; face: Position } | undefined {
    if (against !== undefined) {
      const reference = { x: at.x + against.x, y: at.y + against.y, z: at.z + against.z }
      return this.deps.blocks.isSolid(reference) === true
        ? { reference, face: { x: -against.x, y: -against.y, z: -against.z } }
        : undefined
    }
    const offsets: Position[] = [
      { x: 0, y: -1, z: 0 },
      { x: 0, y: 0, z: -1 },
      { x: 0, y: 0, z: 1 },
      { x: -1, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
    ]
    for (const offset of offsets) {
      const reference = { x: at.x + offset.x, y: at.y + offset.y, z: at.z + offset.z }
      if (this.deps.blocks.isSolid(reference) === true)
        return { reference, face: { x: -offset.x, y: -offset.y, z: -offset.z } }
    }
    return undefined
  }

  private async perform(
    plan: WorkPlan,
    step: WorkStep,
    pending: readonly WorkStep[],
    options: PlanOptions,
    fullSession: ReturnType<InventoryFullHandler['begin']> | undefined,
    progress: Progress,
    context: SkillContext,
  ): Promise<Outcome> {
    const { deps } = this
    const guarded = deps.guard.protectedAt(step.at)
    if (guarded !== undefined)
      return stop(
        failure(
          'protected_area',
          `The cell ${this.where(step.at)} is in the protected area "${guarded.label}".`,
          progress,
        ),
      )

    if (step.kind === 'break' && deps.hazard !== undefined) {
      const hazard = deps.hazard.check(step, plan, {
        order: this.order,
        index: this.order.get(cellKey(step.at)) ?? Infinity,
        dug: this.dug,
      })
      if (hazard !== undefined) {
        if (
          hazard.reason === 'cave_breakthrough' &&
          plan.seal !== undefined &&
          this.canSeal(plan.seal)
        ) {
          // Close the cave instead of stopping here, then carry on as if it had never been open. With nothing to
          // seal it with, fall back to ending the chain as usual, rather than getting stuck trying.
          const moved = await this.standNear(plan, step, pending, options, context)
          if (moved !== undefined) return moved
          const sealed = await this.place(
            hazard.at,
            this.sealBlockFor(plan.seal),
            options,
            progress,
            context,
          )
          if (sealed.kind !== 'done') return sealed
          // The sealed cell may itself be a cell the plan means to dig: it was counted done before sealing (its
          // own target happened to be the cave), so a later round would be the only thing to notice it needs
          // digging again. Do it now instead, in the same pass, so the chain is not left waiting a round behind.
          const coincidesAt = this.order.get(cellKey(hazard.at))
          const coincides = coincidesAt === undefined ? undefined : plan.steps[coincidesAt]
          if (
            coincides !== undefined &&
            coincides.kind === 'break' &&
            !this.dug.has(cellKey(hazard.at))
          ) {
            const dug = await this.perform(
              plan,
              coincides,
              pending,
              options,
              fullSession,
              progress,
              context,
            )
            if (dug.kind !== 'done') return dug
          }
          return this.perform(plan, step, pending, options, fullSession, progress, context)
        }
        return { kind: 'end', hazard }
      }
    }
    if (step.kind === 'light') {
      // A torch goes into an open cell: never dig one out for it (the tunnel that would have made it ended early).
      if (!this.isOpening(deps.blocks.blockAt(step.at))) return { kind: 'done' }
      if (!deps.safety.needsTorch(step.at, step.minLight, step.spacing)) return { kind: 'done' }
      if ((countItems(deps.inventory.snapshot()).get(TORCH) ?? 0) === 0) {
        // Lighting is a courtesy in a building; in a mine it is a rule.
        if (step.required !== true) return { kind: 'done' }
        // Coal or charcoal and sticks make more, if the bot has them.
        await deps.supplies?.craft(TORCH, TORCH_BATCH, context)
        if ((countItems(deps.inventory.snapshot()).get(TORCH) ?? 0) > 0)
          return this.perform(plan, step, pending, options, fullSession, progress, context)
        return stop(
          failure('no_torches', 'There are no torches left to light the way.', progress, {
            missing: [{ name: TORCH, count: 1 }],
          }),
        )
      }
    }
    const moved = await this.standNear(plan, step, pending, options, context)
    if (moved !== undefined) return moved

    switch (step.kind) {
      case 'place':
        return this.place(step.at, step.block, options, progress, context, step.against)
      case 'break':
        return this.breakCell(step.at, fullSession, progress, context, options)
      case 'light': {
        const placed = await this.place(step.at, TORCH, options, progress, context)
        if (placed.kind === 'done') progress.lights += 1
        return placed
      }
      case 'seal': {
        // Already solid (the ordinary case): nothing to do, no material spent.
        if (!isOpenAir(deps.blocks.blockAt(step.at))) return { kind: 'done' }
        // A cave really did hollow it out, and there is nothing to backfill it with: leave it open rather than
        // failing the whole plan for a step that was never the point of the dig.
        if (plan.seal !== undefined && !this.canSeal(plan.seal)) return { kind: 'done' }
        const block = plan.seal !== undefined ? this.sealBlockFor(plan.seal) : step.block
        return this.place(step.at, block, options, progress, context)
      }
    }
  }

  /** Whether the bot carries either the preferred seal block or its fallback. */
  private canSeal(seal: { readonly block: string; readonly fallback: string }): boolean {
    const carried = countItems(this.deps.inventory.snapshot())
    return (carried.get(seal.block) ?? 0) > 0 || (carried.get(seal.fallback) ?? 0) > 0
  }

  /** The seal block to use: the preferred one, or the fallback when none of it is carried. */
  private sealBlockFor(seal: { readonly block: string; readonly fallback: string }): string {
    const carried = countItems(this.deps.inventory.snapshot()).get(seal.block) ?? 0
    return carried > 0 ? seal.block : seal.fallback
  }

  private async standNear(
    plan: WorkPlan,
    step: WorkStep,
    pending: readonly WorkStep[],
    options: PlanOptions,
    context: SkillContext,
  ): Promise<Outcome | undefined> {
    const { deps } = this
    const here = deps.vitals.read()?.position
    if (here === undefined)
      return stop(err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' }))
    const reserved = new Set(pending.filter((s) => s.kind === 'place').map((s) => cellKey(s.at)))
    reserved.add(cellKey(step.at))
    const spot = deps.spots.choose({
      target: step.at,
      from: here,
      reserved,
      avoid: this.avoidOf(plan),
      ...(step.kind === 'place' && step.alignAxis !== undefined
        ? { alignAxis: step.alignAxis }
        : {}),
    })
    if (spot === undefined) {
      // Too high (or too far from any ground) to reach: a tower may do it.
      if (this.scaffolding(options)) return { kind: 'high' }
      return { kind: 'retry', why: `no place to stand near ${this.where(step.at)}` }
    }
    if (spot === here) return undefined
    const walked = await deps.navigator.goToPosition(spot, 0.4, { signal: context.signal })
    if (walked.ok) return undefined
    if (walked.error.reason === 'aborted')
      return stop(err({ reason: 'aborted', message: 'Cancelled.' }))
    return { kind: 'retry', why: `could not walk to ${this.where(spot)}: ${walked.error.message}` }
  }

  private async place(
    at: Position,
    block: string,
    options: PlanOptions,
    progress: Progress,
    context: SkillContext,
    against?: Position,
  ): Promise<Outcome> {
    const { deps } = this
    const found = deps.blocks.blockAt(at)
    if (found !== undefined && !isReplaceable(found)) {
      if (!options.clearObstacles)
        return { kind: 'retry', why: `${found} is in the way at ${this.where(at)}` }
      const cleared = await this.breakCell(at, undefined, progress, context, options)
      if (cleared.kind !== 'done') return cleared
    }
    const support = this.support(at, against)
    if (support === undefined)
      return { kind: 'retry', why: `nothing to place against at ${this.where(at)}` }

    const placed = await deps.placer.placeAgainst(block, support.reference, support.face)
    if (!placed.ok) {
      if (placed.error.reason === 'no_item')
        return stop(
          failure('missing_materials', `Ran out of ${block}.`, progress, {
            missing: [{ name: block, count: 1 }],
          }),
        )
      return { kind: 'retry', why: placed.error.message }
    }
    for (let poll = 0; poll < CONFIRM_POLLS; poll += 1) {
      if (isPlanned(block, deps.blocks.blockAt(at))) {
        progress.placed += 1
        progress.used.set(block, (progress.used.get(block) ?? 0) + 1)
        return { kind: 'done' }
      }
      if (context.signal.aborted) return { kind: 'retry', why: 'cancelled' }
      await sleep(deps.scheduler, CONFIRM_POLL_MS, context.signal)
    }
    return { kind: 'retry', why: `the server did not confirm ${block} at ${this.where(at)}` }
  }

  private async breakCell(
    at: Position,
    fullSession: ReturnType<InventoryFullHandler['begin']> | undefined,
    progress: Progress,
    context: SkillContext,
    options?: PlanOptions,
  ): Promise<Outcome> {
    const { deps } = this
    if (
      deps.inventory.snapshot()?.emptySlots === 0 &&
      options?.spoil === 'discard_junk' &&
      deps.discarder !== undefined
    )
      await deps.discarder.discard(context)
    const snapshot = deps.inventory.snapshot()
    if (snapshot?.emptySlots === 0) {
      if (fullSession === undefined)
        return stop(
          failure(
            'inventory_full',
            'The inventory is full. Free some space, then run it again.',
            progress,
          ),
        )
      const handled = await fullSession.handle(context)
      if (handled.kind === 'stop') return stop(failure('inventory_full', handled.message, progress))
    }
    const assessment = deps.digger.assess(at)
    if (assessment === undefined) return { kind: 'retry', why: `${this.where(at)} is not loaded` }
    if (isOpenAir(assessment.blockName)) return { kind: 'done' }
    if (!assessment.diggable)
      return { kind: 'retry', why: `${assessment.blockName} cannot be broken` }
    if (!assessment.canHarvest) {
      // A pickaxe broke or was never there: make one from what the bot carries, if it can.
      if (await this.craftSpareTool(assessment.requiredTools, context))
        return { kind: 'retry', why: 'crafted a tool' }
      return stop(
        failure(
          'no_suitable_tool',
          `${assessment.blockName} needs ${assessment.requiredTools.join(', ')}. Craft or find one first.`,
          progress,
        ),
      )
    }
    const dug = await deps.digger.dig(at, context.signal)
    if (!dug.ok) {
      if (dug.error.reason === 'aborted')
        return stop(err({ reason: 'aborted', message: 'Cancelled.' }))
      return { kind: 'retry', why: dug.error.message }
    }
    progress.broken += 1
    this.dug.add(cellKey(at))
    await deps.drops.collectNear(at, context.signal)
    return { kind: 'done' }
  }

  /** Crafts the cheapest tool that can break the block, from what the bot carries. True when one was made. */
  private async craftSpareTool(
    required: readonly string[],
    context: SkillContext,
  ): Promise<boolean> {
    const supplies = this.deps.supplies
    if (supplies === undefined) return false
    const candidates = CRAFTABLE_TIERS.flatMap((tier) =>
      required.filter((name) => name.startsWith(`${tier}_`)),
    )
    for (const name of candidates) if (await supplies.craft(name, 1, context)) return true
    return false
  }

  /** Cells to avoid standing in: the volume being built, or, for a shelter built around the bot, everything outside it. */
  private avoidOf(plan: WorkPlan): (cell: Position) => boolean {
    const inside = this.insideOf(plan)
    return plan.standing === 'inside' ? (cell) => !inside(cell) : inside
  }

  /** The volume the plan works in: standing inside it risks being sealed in by the last blocks. */
  private insideOf(plan: WorkPlan): (cell: Position) => boolean {
    if (plan.steps.length < 2) return () => false
    const xs = plan.steps.map((s) => s.at.x)
    const ys = plan.steps.map((s) => s.at.y)
    const zs = plan.steps.map((s) => s.at.z)
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)]
    const [y0, y1] = [Math.min(...ys), Math.max(...ys)]
    const [z0, z1] = [Math.min(...zs), Math.max(...zs)]
    return (cell) =>
      cell.x >= x0 &&
      cell.x <= x1 &&
      cell.z >= z0 &&
      cell.z <= z1 &&
      cell.y >= y0 &&
      cell.y <= y1 + 1
  }

  private where(position: Position | undefined): string {
    return position === undefined
      ? 'an unknown place'
      : `${String(position.x)}, ${String(position.y)}, ${String(position.z)}`
  }
}

type StepKey = string
const keyOf = (step: WorkStep): StepKey => `${step.kind}:${cellKey(step.at)}`

type Outcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'retry'; readonly why: string }
  /** Cannot be reached from the ground: wait for a tower. */
  | { readonly kind: 'high' }
  /** A hazard ends this cell's chain. */
  | { readonly kind: 'end'; readonly hazard: Hazard }
  | { readonly kind: 'stop'; readonly result: SkillResult<PlanOutcome> }

const stop = (result: SkillResult<PlanOutcome>): Outcome => ({ kind: 'stop', result })
