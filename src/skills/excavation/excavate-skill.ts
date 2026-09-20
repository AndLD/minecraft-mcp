import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
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

/** A rough figure for the preview: breaking a block, picking up the drop, and moving on. */
const SECONDS_PER_BLOCK = 0.7

export interface ExcavateInput {
  readonly shape: string
  /** Validated by the shape's own schema. */
  readonly params: unknown
  /** Where the dig starts; see each shape. Without it, it is worked out from where the bot stands. */
  readonly origin: Position | undefined
  readonly fetchFromStorage: boolean
  readonly onInventoryFull?: InventoryFullKind | undefined
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
}

export interface ExcavateDeps {
  readonly registry: ExcavationRegistry
  readonly executor: PlanExecutor
  readonly vitals: VitalsReader
  readonly fetcher?: MaterialFetcher
}

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
    const { plan, origin, defaultOrigin, interpreted } = prepared.value
    const preview = this.deps.executor.preview(plan, this.optionsFor(input))
    return ok({
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
    const { plan, origin } = prepared.value
    const options = this.optionsFor(input)
    const { executor, fetcher } = this.deps

    const fetched: ItemCount[] = []
    const needed = executor.preview(plan, options).missing
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
    return ok({ ...done.value, shape: plan.name, origin, bounds: boundsOf(plan), fetched })
  }

  private optionsFor(input: ExcavateInput): PlanOptions {
    return {
      // Digging is what this is for; natural blocks in the way are simply part of it.
      clearObstacles: true,
      onInventoryFull: input.onInventoryFull,
      scaffold: undefined,
    }
  }

  private prepare(input: ExcavateInput): SkillResult<{
    plan: WorkPlan
    origin: Position
    defaultOrigin: boolean
    interpreted: unknown
  }> {
    const provider = this.deps.registry.get(input.shape)
    if (provider === undefined)
      return err({
        reason: 'unknown_shape',
        message: `There is no shape "${input.shape}". Known: ${this.deps.registry.names().join(', ')}.`,
      })
    const parsed = provider.params.safeParse(input.params)
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

    const defaultOrigin = input.origin === undefined
    const origin = input.origin ?? provider.defaultOrigin(vitals.position, parsed.data)
    const plan = provider.generate(parsed.data, { origin, minY: lowestLayer(vitals.dimension) })
    if ('error' in plan) return err({ reason: 'invalid_shape', message: plan.error })
    return ok({ plan, origin, defaultOrigin, interpreted: parsed.data })
  }
}
