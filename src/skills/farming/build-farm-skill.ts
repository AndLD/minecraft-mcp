import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { ItemCount } from '../../core/recipes.port.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { FarmEntry, FarmRegistry } from '../../state/farm-registry.js'
import type { ProtectedAreas } from '../../state/protected-areas.js'
import type { InventoryFullKind } from '../../state/storage-policy.js'
import type { MaterialFetcher } from '../building/material-fetcher.js'
import type {
  PlanExecutor,
  PlanOptions,
  PlanOutcome,
  PlanPreview,
} from '../construction/plan-executor.js'
import type { WorkPlan } from '../construction/work-plan.types.js'
import type { Bounds } from './farm-area.types.js'
import type { FarmLayoutRegistry } from './farm-layout-registry.js'
import type { FarmLayoutProvider } from './farm-layout.types.js'
import type { PlantCropsSkill } from './plant-crops-skill.js'

export interface BuildFarmInput {
  readonly kind: string
  /** Validated by the kind's own schema. */
  readonly params: unknown
  /** Where the layout starts; see each kind. Without it, it is worked out from where the bot stands. */
  readonly origin: Position | undefined
  readonly label?: string | undefined
  readonly group?: string | undefined
  /** The herd size `tend_farm` breeds up to and culls down to, for a pen. */
  readonly herdTarget?: number | undefined
  readonly fetchFromStorage: boolean
  readonly onInventoryFull?: InventoryFullKind | undefined
}

export interface BuildFarmOutput extends PlanOutcome {
  readonly kind: string
  readonly origin: Position
  readonly bounds: Bounds
  readonly farm: FarmEntry
  /** Whether the footprint was protected from other tasks (best-effort; never blocks the build). */
  readonly protectedArea: boolean
  /** Materials taken out of containers for the job. */
  readonly fetched: readonly ItemCount[]
  /** Plots planted right after the build (best-effort; a build without enough seeds still succeeds). */
  readonly planted: number
}

export interface BuildFarmPreview extends PlanPreview {
  readonly kind: string
  /** The parameters as understood, defaults filled in. */
  readonly interpreted: unknown
  readonly origin: Position
  readonly defaultOrigin: boolean
  readonly bounds: Bounds
}

export interface BuildFarmDeps {
  readonly registry: FarmLayoutRegistry
  readonly executor: PlanExecutor
  readonly vitals: VitalsReader
  readonly farms: FarmRegistry
  readonly protectedAreas: ProtectedAreas
  /** Lets a layout look at the ground it is built on (the pen clears its interior). */
  readonly blocks?: BlockScanner
  readonly fetcher?: MaterialFetcher
  /** Plants the field right after building it, when the kind grows a crop. */
  readonly plant?: PlantCropsSkill
}

const FARM_KINDS = ['field', 'pen', 'grove', 'apiary'] as const
const isFarmKind = (kind: string): kind is FarmEntry['kind'] =>
  (FARM_KINDS as readonly string[]).includes(kind)

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
 * Lays out a farm component (`field`, `pen`) as a `WorkPlan` and hands it to the shared `PlanExecutor`, the same way
 * `excavate` and `build` do. On success the component is registered in the `FarmRegistry` and its footprint is
 * protected like any player build, so other tasks never dig or build over it by accident.
 */
export class BuildFarmSkill implements Skill<BuildFarmInput, BuildFarmOutput> {
  readonly name = 'build_farm'

  constructor(private readonly deps: BuildFarmDeps) {}

  preview(input: BuildFarmInput): SkillResult<BuildFarmPreview> {
    const prepared = this.prepare(input)
    if (!prepared.ok) return prepared
    const { plan, origin, defaultOrigin, interpreted } = prepared.value
    const preview = this.deps.executor.preview(plan, this.optionsFor(input))
    return ok({
      ...preview,
      kind: plan.name,
      interpreted,
      origin,
      defaultOrigin,
      bounds: boundsOf(plan),
    })
  }

  async run(input: BuildFarmInput, context: SkillContext): Promise<SkillResult<BuildFarmOutput>> {
    const prepared = this.prepare(input)
    if (!prepared.ok) return prepared
    const { plan, origin, provider, params } = prepared.value
    const options = this.optionsFor(input)
    const { executor, fetcher } = this.deps

    const fetched: ItemCount[] = []
    const preview0 = executor.preview(plan, options)
    const needed = [...preview0.missing, ...preview0.optionalMissing]
    if (needed.length > 0 && input.fetchFromStorage && fetcher !== undefined) {
      await fetcher.fetch(needed, context)
      fetched.push(...needed)
    }

    const done = await executor.run(plan, options, context)
    if (!done.ok) return err({ ...done.error, detail: { ...done.error.detail, origin } })

    if (!isFarmKind(provider.kind))
      return err({
        reason: 'invalid_shape',
        message: `The provider for "${provider.kind}" is registered with a kind FarmRegistry does not know.`,
      })
    const bounds = boundsOf(plan)
    const crop = provider.cropOf?.(params)
    const species = provider.speciesOf?.(params)
    const gateSide = provider.gateSideOf?.(params)
    const registered = this.deps.farms.register({
      kind: provider.kind,
      crop,
      species,
      herdTarget: input.herdTarget,
      gateSide,
      bounds,
      label: input.label,
      group: input.group,
      builtByBot: true,
    })
    if (!registered.ok) return err({ reason: 'registration_failed', message: registered.error })
    const protection = this.deps.protectedAreas.add(
      registered.value.label ?? registered.value.id,
      bounds.from,
      bounds.to,
    )

    let planted = 0
    if (crop !== undefined && this.deps.plant !== undefined) {
      const planting = await this.deps.plant.run(
        { farm: undefined, area: bounds, crop, maxPlants: undefined },
        context,
      )
      if (planting.ok) planted = planting.value.planted
    }

    return ok({
      ...done.value,
      kind: plan.name,
      origin,
      bounds,
      farm: registered.value,
      protectedArea: protection.ok,
      fetched,
      planted,
    })
  }

  private optionsFor(input: BuildFarmInput): PlanOptions {
    return {
      clearObstacles: true,
      onInventoryFull: input.onInventoryFull,
      spoil: undefined,
      scaffold: undefined,
    }
  }

  private prepare(input: BuildFarmInput): SkillResult<{
    plan: WorkPlan
    origin: Position
    defaultOrigin: boolean
    interpreted: unknown
    provider: FarmLayoutProvider
    params: unknown
  }> {
    const provider = this.deps.registry.get(input.kind)
    if (provider === undefined)
      return err({
        reason: 'unknown_kind',
        message: `There is no farm kind "${input.kind}". Known: ${this.deps.registry.kinds().join(', ')}.`,
      })
    const parsed = provider.params.safeParse(input.params)
    if (!parsed.success)
      return err({
        reason: 'invalid_params',
        message: `Wrong parameters for ${input.kind}: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'params'}: ${issue.message}`)
          .join('; ')}.`,
      })
    const vitals = this.deps.vitals.read()
    if (vitals === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })

    const defaultOrigin = input.origin === undefined
    const origin = input.origin ?? provider.defaultOrigin(vitals.position, parsed.data)
    const blocks = this.deps.blocks
    const plan = provider.generate(parsed.data, {
      origin,
      ...(blocks === undefined
        ? {}
        : { blockAt: (position: Position) => blocks.blockAt(position) }),
    })
    if ('error' in plan) return err({ reason: 'invalid_shape', message: plan.error })
    return ok({
      plan,
      origin,
      defaultOrigin,
      interpreted: parsed.data,
      provider,
      params: parsed.data,
    })
  }
}
