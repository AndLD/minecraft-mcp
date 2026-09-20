import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { InventoryFullKind } from '../../state/storage-policy.js'
import type {
  PlanExecutor,
  PlanOptions,
  PlanOutcome,
  PlanPreview,
} from '../construction/plan-executor.js'
import { boundsOf, planFor } from './blueprint-plan.js'
import type { Blueprint } from './blueprint.types.js'
import type { BlueprintRegistry } from './blueprint-registry.js'
import type { MaterialFetcher } from './material-fetcher.js'

/** Without an origin the blueprint's lowest corner is this many blocks east of the bot's feet. */
const DEFAULT_OFFSET_X = 2

export interface BuildInput {
  readonly blueprint: string
  /** Validated by the blueprint's own schema. */
  readonly params: unknown
  /** The lowest corner (smallest x, y, and z). Defaults to two blocks east of the bot. */
  readonly origin: Position | undefined
  readonly clearObstacles: boolean
  readonly fetchFromStorage: boolean
  /** The block a scaffold tower is made of (see `maxScaffoldHeight`). */
  readonly scaffoldBlock: string
  /** How high the bot may pillar up to reach high steps; 0 keeps it on the ground. */
  readonly maxScaffoldHeight: number
  readonly onInventoryFull?: InventoryFullKind | undefined
}

export interface BuildOutput extends PlanOutcome {
  readonly blueprint: string
  readonly origin: Position
  readonly bounds: { readonly from: Position; readonly to: Position }
  /** What was taken out of containers for the job. */
  readonly fetched: readonly ItemCount[]
}

export interface BuildPreview extends PlanPreview {
  readonly blueprint: string
  readonly origin: Position
  /** True when the origin was worked out from the bot's position: the agent may want to move it. */
  readonly defaultOrigin: boolean
  readonly bounds: { readonly from: Position; readonly to: Position }
}

export interface BuildDeps {
  readonly registry: BlueprintRegistry
  readonly executor: PlanExecutor
  readonly vitals: VitalsReader
  readonly fetcher?: MaterialFetcher
}

/**
 * Builds a blueprint: the shape becomes a plan, the missing materials are fetched from containers when allowed, and
 * the `PlanExecutor` does the work. `preview` says what it would take without touching anything.
 */
export class BuildSkill implements Skill<BuildInput, BuildOutput> {
  readonly name = 'build'

  constructor(private readonly deps: BuildDeps) {}

  preview(input: BuildInput): SkillResult<BuildPreview> {
    const prepared = this.prepare(input)
    if (!prepared.ok) return prepared
    const { blueprint, origin, defaultOrigin } = prepared.value
    const preview = this.deps.executor.preview(planFor(blueprint, origin), this.optionsFor(input))
    return ok({
      ...preview,
      blueprint: blueprint.name,
      origin,
      defaultOrigin,
      bounds: boundsOf(blueprint, origin),
    })
  }

  async run(input: BuildInput, context: SkillContext): Promise<SkillResult<BuildOutput>> {
    const prepared = this.prepare(input)
    if (!prepared.ok) return prepared
    const { blueprint, origin } = prepared.value
    const plan = planFor(blueprint, origin)
    const options = this.optionsFor(input)
    const { executor, fetcher } = this.deps

    const fetched: ItemCount[] = []
    const needed = executor.preview(plan, options).missing
    if (needed.length > 0 && input.fetchFromStorage && fetcher !== undefined) {
      await fetcher.fetch(needed, context)
      fetched.push(...needed)
    }

    const done = await executor.run(plan, options, context)
    if (!done.ok) return err(this.withHint(done.error, origin))
    return ok({
      ...done.value,
      blueprint: blueprint.name,
      origin,
      bounds: boundsOf(blueprint, origin),
      fetched,
    })
  }

  private optionsFor(input: BuildInput): PlanOptions {
    return {
      clearObstacles: input.clearObstacles,
      onInventoryFull: input.onInventoryFull,
      scaffold:
        input.maxScaffoldHeight > 0
          ? { block: input.scaffoldBlock, maxHeight: input.maxScaffoldHeight }
          : undefined,
    }
  }

  private prepare(
    input: BuildInput,
  ): SkillResult<{ blueprint: Blueprint; origin: Position; defaultOrigin: boolean }> {
    const provider = this.deps.registry.get(input.blueprint)
    if (provider === undefined)
      return err({
        reason: 'unknown_blueprint',
        message: `There is no blueprint "${input.blueprint}". Known: ${this.deps.registry.names().join(', ')}.`,
      })
    const parsed = provider.params.safeParse(input.params)
    if (!parsed.success)
      return err({
        reason: 'invalid_params',
        message: `Wrong parameters for ${input.blueprint}: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'params'}: ${issue.message}`)
          .join('; ')}. See list_blueprints.`,
      })

    const blueprint = provider.generate(parsed.data)
    let origin = input.origin
    const defaultOrigin = origin === undefined
    if (origin === undefined) {
      const here = this.deps.vitals.read()?.position
      if (here === undefined)
        return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
      const feet = { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) }
      // A shelter is built around the bot: its anchor cell is where the bot stands. Otherwise beside the bot.
      origin =
        blueprint.anchor === undefined
          ? { x: feet.x + DEFAULT_OFFSET_X, y: feet.y, z: feet.z }
          : {
              x: feet.x - blueprint.anchor.dx,
              y: feet.y - blueprint.anchor.dy,
              z: feet.z - blueprint.anchor.dz,
            }
    }
    return ok({ blueprint, origin, defaultOrigin })
  }

  private withHint(
    failure: { reason: string; message: string; detail?: Readonly<Record<string, unknown>> },
    origin: Position,
  ) {
    const hint =
      failure.reason === 'missing_materials'
        ? ' Offer to gather, craft, or hunt what is missing, or to fetch it from a chest.'
        : ''
    return {
      ...failure,
      message: failure.message + hint,
      detail: { ...failure.detail, origin },
    }
  }
}
