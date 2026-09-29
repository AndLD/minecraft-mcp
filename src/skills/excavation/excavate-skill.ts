import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { ExcavationRecord, ExcavationRecords } from '../../state/excavation-records.js'
import type { InventoryFullKind } from '../../state/storage-policy.js'
import type { MaterialFetcher } from '../building/material-fetcher.js'
import type {
  PlanExecutor,
  PlanOptions,
  PlanOutcome,
  PlanPreview,
} from '../construction/plan-executor.js'
import type { WorkPlan } from '../construction/work-plan.types.js'
import type { ExcavationRegistry } from './excavation-registry.js'
import type { ExcavationProvider } from './excavation.types.js'

/** A rough figure for the preview: breaking a block, picking up the drop, and moving on. */
const SECONDS_PER_BLOCK = 0.7

export interface ExcavateInput {
  readonly shape: string
  /** Validated by the shape's own schema. */
  readonly params: unknown
  /** Where the dig starts; see each shape. Without it, it is worked out from where the bot stands. */
  readonly origin: Position | undefined
  readonly fetchFromStorage: boolean
  /** Where the spoil goes when the inventory is full: the standing storage policy (default), or the junk is thrown away. */
  readonly spoilPolicy?: 'storage' | 'discard_junk' | undefined
  readonly onInventoryFull?: InventoryFullKind | undefined
  /** Sand or gravel above a block about to be broken: end the chain (default) or dig the column first. */
  readonly fallingBlocks?: 'stop' | 'clear' | undefined
  /**
   * Continue a pit, shaft, or quarry the bot dug before (found in the records by `origin`, or by where the bot stands):
   * the same footprint and way out, extended to the target given in `params` (or re-checked at its old depth).
   */
  readonly continueExisting?: boolean | undefined
}

/** What a continued dig found, and what it will add. */
export interface ContinuedDig {
  readonly record: string
  readonly shape: ExcavationRecord['shape']
  readonly origin: Position
  readonly width: number
  readonly length: number
  readonly exit: ExcavationRecord['exit']
  /** Layers found dug at the origin column, and the y of the lowest of them. */
  readonly existingLayers: number
  readonly existingBottom: number
  readonly targetBottom: number
  /** Layers the plan digs beyond what is there. */
  readonly addLayers: number
  readonly summary: string
}

export interface Bounds {
  readonly from: Position
  readonly to: Position
}

export interface ExcavateOutput extends PlanOutcome {
  readonly shape: string
  readonly origin: Position
  readonly bounds: Bounds
  /** Materials taken out of containers for the job (ladders, torches). */
  readonly fetched: readonly ItemCount[]
  /** Set when this continued a dig the bot made before. */
  readonly continued?: ContinuedDig
}

export interface ExcavatePreview extends PlanPreview {
  readonly shape: string
  /** The parameters as understood, defaults filled in: what a wrong reading of the request would show up in. */
  readonly interpreted: unknown
  readonly origin: Position
  readonly defaultOrigin: boolean
  readonly bounds: Bounds
  /** Blocks that would be dug, and a rough time for them. */
  readonly blocks: number
  readonly estimatedMinutes: number
  /** Set when this continues a dig the bot made before: what was found and what will be added. */
  readonly continuing?: ContinuedDig
}

export interface ExcavateDeps {
  readonly registry: ExcavationRegistry
  readonly executor: PlanExecutor
  readonly vitals: VitalsReader
  readonly fetcher?: MaterialFetcher
  /** The digs the bot made (for `continue_existing`); without it nothing is recorded and nothing can be continued. */
  readonly records?: ExcavationRecords
  /** Reads what is dug at the origin of a continued dig. */
  readonly blocks?: BlockScanner
}

const OPEN_IN_A_HOLE = new Set(['air', 'cave_air', 'void_air', 'ladder', 'torch', 'wall_torch'])
const RECORDED_SHAPES = new Set(['pit', 'shaft', 'quarry'])

/** The lowest layer of a dimension. The Nether and the End bottom out at 0, the overworld at -64. */
export function lowestLayer(dimension: string): number {
  return /nether|end/i.test(dimension) ? 0 : -64
}

const boundsOf = (plan: WorkPlan): Bounds => {
  const xs = plan.steps.map((s) => s.at.x)
  const ys = plan.steps.map((s) => s.at.y)
  const zs = plan.steps.map((s) => s.at.z)
  return {
    from: { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) },
    to: { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) },
  }
}

/**
 * Digs a shape (pit, shaft, quarry, tunnel, branch mine, staircase). The shape becomes a `WorkPlan` that the shared
 * executor carries out with the hazard rule switched on: a chain of cells that meets lava, water, a cave, and so on
 * simply ends there, and the result says where and why.
 */
export class ExcavateSkill implements Skill<ExcavateInput, ExcavateOutput> {
  readonly name = 'excavate'

  constructor(private readonly deps: ExcavateDeps) {}

  preview(input: ExcavateInput): SkillResult<ExcavatePreview> {
    const prepared = this.prepare(input)
    if (!prepared.ok) return prepared
    const { plan, origin, defaultOrigin, interpreted, continued } = prepared.value
    const preview = this.deps.executor.preview(plan, this.optionsFor(input))
    return ok({
      ...(continued === undefined ? {} : { continuing: continued }),
      ...preview,
      shape: plan.name,
      interpreted,
      origin,
      defaultOrigin,
      bounds: boundsOf(plan),
      blocks: preview.toBreak,
      estimatedMinutes: Math.round((preview.toBreak * SECONDS_PER_BLOCK) / 60),
    })
  }

  async run(input: ExcavateInput, context: SkillContext): Promise<SkillResult<ExcavateOutput>> {
    const prepared = this.prepare(input)
    if (!prepared.ok) return prepared
    const { plan, origin, provider, params, continued } = prepared.value
    const options = this.optionsFor(input)
    this.remember(input.shape, params, plan, origin)
    const { executor, fetcher } = this.deps

    const confirm = provider.needsConfirmation?.(params)
    if (confirm !== undefined && context.ask !== undefined) {
      const answer = await context.ask(confirm)
      if (answer === undefined)
        return err({ reason: 'aborted', message: 'Cancelled while waiting for an answer.' })
    }

    const fetched: ItemCount[] = []
    const preview0 = executor.preview(plan, options)
    const needed = [...preview0.missing, ...preview0.optionalMissing]
    if (needed.length > 0 && input.fetchFromStorage && fetcher !== undefined) {
      await fetcher.fetch(needed, context)
      fetched.push(...needed)
    }

    const done = await executor.run(plan, options, context)
    if (!done.ok) {
      const hint =
        done.error.reason === 'missing_materials' || done.error.reason === 'no_torches'
          ? ' Offer to craft or fetch it (ladders and torches are crafted from sticks, coal, or charcoal).'
          : ''
      return err({
        ...done.error,
        message: done.error.message + hint,
        detail: { ...done.error.detail, origin },
      })
    }
    return ok({
      ...done.value,
      shape: plan.name,
      origin,
      bounds: boundsOf(plan),
      fetched,
      ...(continued === undefined ? {} : { continued }),
    })
  }

  private optionsFor(input: ExcavateInput): PlanOptions {
    return {
      // Digging is what this is for; natural blocks in the way are simply part of it.
      clearObstacles: true,
      onInventoryFull: input.onInventoryFull,
      spoil: input.spoilPolicy,
      scaffold: undefined,
    }
  }

  /** The dig to continue: named by its origin, or the one under or around where the bot stands. */
  private findRecord(
    input: ExcavateInput,
    here: Position | undefined,
  ): SkillResult<ExcavationRecord> {
    const { records, blocks } = this.deps
    if (records === undefined || blocks === undefined)
      return err({
        reason: 'not_recognised',
        message: 'Continuing a dig is not available here (no record of digs is kept).',
      })
    if (!RECORDED_SHAPES.has(input.shape))
      return err({
        reason: 'not_recognised',
        message: `continue_existing works for pit, shaft, and quarry, not ${input.shape}.`,
      })
    const reference = input.origin ?? here
    if (reference === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
    const exact = input.origin === undefined ? undefined : records.at(input.origin)
    const candidates = exact === undefined ? records.near(reference) : [exact]
    const inside = candidates.filter(
      (r) =>
        reference.x >= r.origin.x &&
        reference.x < r.origin.x + r.width &&
        reference.z >= r.origin.z &&
        reference.z < r.origin.z + r.length,
    )
    const pool = inside.length > 0 ? inside : candidates
    const record = pool[0]
    const unrecognised = (why: string) =>
      err({
        reason: 'not_recognised',
        message: `${why} Give the origin (the top-layer corner) of the dig to continue, or dig it again with its own size: the same numbers over the same origin only dig what is missing.`,
      })
    if (record === undefined)
      return unrecognised('There is no record of a pit, shaft, or quarry the bot dug here.')
    if (pool.length > 1)
      return unrecognised(
        `Several digs are near: ${pool.map((r) => `${r.shape} ${String(r.width)}x${String(r.length)} at ${String(r.origin.x)}, ${String(r.origin.y)}, ${String(r.origin.z)}`).join('; ')}.`,
      )
    if (record.shape !== input.shape)
      return unrecognised(`The dig found is a ${record.shape}, not a ${input.shape}.`)
    const top = blocks.blockAt(record.origin)
    if (top === undefined || !OPEN_IN_A_HOLE.has(top))
      return unrecognised(
        `The dig recorded at ${String(record.origin.x)}, ${String(record.origin.y)}, ${String(record.origin.z)} does not look dug any more (${top ?? 'not loaded'} at its top corner).`,
      )
    return ok(record)
  }

  /** The recorded numbers, with what the request names on top (the new target, a different way out, and so on). */
  private mergedParams(record: ExcavationRecord, given: unknown): Record<string, unknown> {
    const asked =
      typeof given === 'object' && given !== null ? (given as Record<string, unknown>) : {}
    const target =
      record.shape === 'quarry'
        ? { to_y: record.bottom }
        : { depth: record.origin.y - record.bottom + 1 }
    const merged: Record<string, unknown> = {
      width: record.width,
      length: record.length,
      exit: record.exit,
      stair_width: record.stairWidth,
      stair_height: record.stairHeight,
      seal_caves: record.sealCaves,
      seal_block: record.sealBlock,
      ...target,
      ...asked,
    }
    // A new target given in the other unit replaces the recorded one.
    if (asked['above_bedrock'] !== undefined && asked['to_y'] === undefined) delete merged['to_y']
    return merged
  }

  private describeContinued(
    record: ExcavationRecord,
    plan: WorkPlan,
    origin: Position,
  ): ContinuedDig {
    let existingLayers = 0
    for (let y = origin.y; ; y -= 1) {
      const name = this.deps.blocks?.blockAt({ x: origin.x, y, z: origin.z })
      if (name === undefined || !OPEN_IN_A_HOLE.has(name)) break
      existingLayers += 1
    }
    const targetBottom = Math.min(
      ...plan.steps.filter((s) => s.branch?.startsWith('column-') === true).map((s) => s.at.y),
    )
    const existingBottom = origin.y - existingLayers + 1
    const addLayers = Math.max(existingBottom - targetBottom, 0)
    const way =
      record.exit === 'stairs'
        ? `stairs ${String(record.stairWidth)} wide, ${String(record.stairHeight)} high`
        : record.exit === 'ladder'
          ? 'ladders'
          : 'no way out'
    return {
      record: record.id,
      shape: record.shape,
      origin,
      width: record.width,
      length: record.length,
      exit: record.exit,
      existingLayers,
      existingBottom,
      targetBottom,
      addLayers,
      summary: `Found a ${String(record.width)}x${String(record.length)} ${record.shape}, ${String(existingLayers)} deep (down to y ${String(existingBottom)}), ${way}. It will be dug down to y ${String(targetBottom)}: ${String(addLayers)} more layer(s), with the way out carried on from the last step.`,
    }
  }

  /** Records a pit, shaft, or quarry, so a later request can continue it. */
  private remember(shape: string, params: unknown, plan: WorkPlan, origin: Position): void {
    if (!RECORDED_SHAPES.has(shape) || this.deps.records === undefined) return
    const p = params as {
      width: number
      length: number
      exit: ExcavationRecord['exit']
      stair_width: number
      stair_height: number
      seal_caves: boolean
      seal_block: string
    }
    const bottoms = plan.steps
      .filter((s) => s.branch?.startsWith('column-') === true)
      .map((s) => s.at.y)
    if (bottoms.length === 0) return
    this.deps.records.record({
      shape: shape as ExcavationRecord['shape'],
      origin,
      width: p.width,
      length: p.length,
      bottom: Math.min(...bottoms),
      exit: p.exit,
      stairWidth: p.stair_width,
      stairHeight: p.stair_height,
      sealCaves: p.seal_caves,
      sealBlock: p.seal_block,
    })
  }

  private prepare(input: ExcavateInput): SkillResult<{
    plan: WorkPlan
    origin: Position
    defaultOrigin: boolean
    interpreted: unknown
    provider: ExcavationProvider
    params: unknown
    continued: ContinuedDig | undefined
  }> {
    let foundRecord: ExcavationRecord | undefined
    const provider = this.deps.registry.get(input.shape)
    if (provider === undefined)
      return err({
        reason: 'unknown_shape',
        message: `There is no shape "${input.shape}". Known: ${this.deps.registry.names().join(', ')}.`,
      })
    const vitalsNow = this.deps.vitals.read()
    let givenParams = input.params
    let givenOrigin = input.origin
    if (input.continueExisting === true) {
      const found = this.findRecord(input, vitalsNow?.position)
      if (!found.ok) return found
      givenParams = this.mergedParams(found.value, input.params)
      givenOrigin = found.value.origin
      foundRecord = found.value
    }
    const parsed = provider.params.safeParse(givenParams)
    if (!parsed.success)
      return err({
        reason: 'invalid_params',
        message: `Wrong parameters for ${input.shape}: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'params'}: ${issue.message}`)
          .join('; ')}. See list_excavations.`,
      })
    const vitals = this.deps.vitals.read()
    if (vitals === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })

    const defaultOrigin = givenOrigin === undefined
    const origin = givenOrigin ?? provider.defaultOrigin(vitals.position, parsed.data)
    const generated = provider.generate(parsed.data, {
      origin,
      minY: lowestLayer(vitals.dimension),
    })
    if ('error' in generated) return err({ reason: 'invalid_shape', message: generated.error })
    // Every shape is read back at the end: stray blocks cleared, sealing checked (see `WorkPlan.verify`).
    const plan: WorkPlan = {
      ...generated,
      verify: true,
      ...(input.fallingBlocks === undefined ? {} : { fallingBlocks: input.fallingBlocks }),
    }
    const continued =
      foundRecord === undefined ? undefined : this.describeContinued(foundRecord, plan, origin)
    return ok({
      plan,
      origin,
      defaultOrigin,
      interpreted: parsed.data,
      provider,
      params: parsed.data,
      continued,
    })
  }
}
