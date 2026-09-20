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
/** The plan is checked against the world this many times (the second look is the verification pass). */
const ROUNDS = 2
const SAMPLE = 10

export interface PlanOptions {
  /** Break natural blocks that are in the way of a placement, instead of refusing. Protected areas are never broken. */
  readonly clearObstacles: boolean
  /** What to do when the inventory fills up while breaking; the standing policy when undefined. */
  readonly onInventoryFull?: InventoryFullKind | undefined
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
}

export interface PlanOutcome {
  readonly steps: number
  readonly placed: number
  readonly broken: number
  readonly lights: number
  readonly alreadyDone: number
  readonly used: readonly ItemCount[]
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
    let protectedArea: string | undefined
    for (const step of plan.steps) {
      protectedArea ??= deps.guard.protectedAt(step.at)?.label
      const found = deps.blocks.blockAt(step.at)
      if (step.kind === 'light') {
        torches += 1
        continue
      }
      if (step.kind === 'break') {
        if (isOpenAir(found)) done += 1
        else toBreak += 1
        continue
      }
      if (isPlanned(step.block, found)) {
        done += 1
        continue
      }
      toPlace += 1
      needs.set(step.block, (needs.get(step.block) ?? 0) + 1)
      if (found !== undefined && !isReplaceable(found)) {
        if (options.clearObstacles) toBreak += 1
        else blocked.push(step.at)
      }
    }
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
      hazards: deps.safety.hazards(plan),
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

    for (let round = 0; round < ROUNDS; round += 1) {
      const pending = plan.steps.filter((step) => !this.satisfied(step) && !failed.has(keyOf(step)))
      if (pending.length === 0) break
      if (round === 0) context.progress(`Working on ${plan.name}: ${String(pending.length)} steps`)
      while (pending.length > 0) {
        if (context.signal.aborted) return failure('aborted', 'Cancelled.', progress)
        const step = this.next(pending)
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
          pending,
          options,
          fullSession,
          progress,
          context,
        )
        if (outcome.kind === 'stop') return outcome.result
        if (outcome.kind === 'retry') {
          const tried = (attempts.get(keyOf(step)) ?? 0) + 1
          attempts.set(keyOf(step), tried)
          if (tried < MAX_ATTEMPTS) pending.push(step)
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
        } else inARow = 0
        context.progress(`Placed ${String(progress.placed)}, broke ${String(progress.broken)}`)
      }
    }

    if (failed.size > 0) {
      const reasons = [...new Set(failed.values())].join('; ')
      return failure(
        'incomplete',
        `${String(failed.size)} step(s) could not be done (${reasons}). Run it again to try the rest.`,
        progress,
        { failedSteps: failed.size, reasons: [...new Set(failed.values())] },
      )
    }
    // Lighting is a courtesy (no torches, no torch), so it is not part of what must hold.
    const stillOpen = plan.steps.filter(
      (step) => step.kind !== 'light' && !this.satisfied(step),
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
    })
  }

  /** The first pending step that can be done now: breaks and lights always, placements once something supports them. */
  private next(pending: readonly WorkStep[]): WorkStep | undefined {
    return pending.find((step) => step.kind !== 'place' || this.support(step.at) !== undefined)
  }

  private satisfied(step: WorkStep): boolean {
    const found = this.deps.blocks.blockAt(step.at)
    switch (step.kind) {
      case 'place':
        return isPlanned(step.block, found)
      case 'break':
        return isOpenAir(found)
      case 'light':
        return !this.deps.safety.needsTorch(step.at, step.minLight)
    }
  }

  /** A neighbouring solid block to place against, preferring the one below. */
  private support(at: Position): { reference: Position; face: Position } | undefined {
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

    if (step.kind === 'light') {
      // Lighting is a courtesy: nothing to do when it is bright enough, or when there are no torches.
      if (!deps.safety.needsTorch(step.at, step.minLight)) return { kind: 'done' }
      if ((countItems(deps.inventory.snapshot()).get(TORCH) ?? 0) === 0) return { kind: 'done' }
    }
    const moved = await this.standNear(plan, step, pending, context)
    if (moved !== undefined) return moved

    switch (step.kind) {
      case 'place':
        return this.place(step.at, step.block, options, progress, context)
      case 'break':
        return this.breakCell(step.at, fullSession, progress, context)
      case 'light': {
        const placed = await this.place(step.at, TORCH, options, progress, context)
        if (placed.kind === 'done') progress.lights += 1
        return placed
      }
    }
  }

  private async standNear(
    plan: WorkPlan,
    step: WorkStep,
    pending: readonly WorkStep[],
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
    if (spot === undefined)
      return { kind: 'retry', why: `no place to stand near ${this.where(step.at)}` }
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
  ): Promise<Outcome> {
    const { deps } = this
    const found = deps.blocks.blockAt(at)
    if (found !== undefined && !isReplaceable(found)) {
      if (!options.clearObstacles)
        return { kind: 'retry', why: `${found} is in the way at ${this.where(at)}` }
      const cleared = await this.breakCell(at, undefined, progress, context)
      if (cleared.kind !== 'done') return cleared
    }
    const support = this.support(at)
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
  ): Promise<Outcome> {
    const { deps } = this
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
    if (!assessment.canHarvest)
      return stop(
        failure(
          'no_suitable_tool',
          `${assessment.blockName} needs ${assessment.requiredTools.join(', ')}. Craft or find one first.`,
          progress,
        ),
      )
    const dug = await deps.digger.dig(at, context.signal)
    if (!dug.ok) {
      if (dug.error.reason === 'aborted')
        return stop(err({ reason: 'aborted', message: 'Cancelled.' }))
      return { kind: 'retry', why: dug.error.message }
    }
    progress.broken += 1
    await deps.drops.collectNear(at, context.signal)
    return { kind: 'done' }
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
  | { readonly kind: 'stop'; readonly result: SkillResult<PlanOutcome> }

const stop = (result: SkillResult<PlanOutcome>): Outcome => ({ kind: 'stop', result })
