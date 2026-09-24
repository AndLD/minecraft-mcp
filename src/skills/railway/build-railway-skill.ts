import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { EntityScanner } from '../../core/entity-scanner.port.js'
import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { RailwayLog } from '../../state/railway-log.js'
import type { InventoryFullKind } from '../../state/storage-policy.js'
import type { MaterialFetcher } from '../building/material-fetcher.js'
import type {
  PlanExecutor,
  PlanOptions,
  PlanOutcome,
  PlanPreview,
} from '../construction/plan-executor.js'
import type { Variant } from './rail-layout.js'
import { isCorner } from './rail-orientation.js'
import type { Layout, RailRoute, RailRoutePlanner } from './rail-route-planner.js'
import {
  ECONOMY_SPACING_DEFAULT,
  ECONOMY_SPACING_MAX,
  ECONOMY_SPACING_MIN,
  rawMaterialsFor,
  type ItemAmount,
} from './rail-table.js'
import type { RailVerifier, Verification } from './rail-verifier.js'
import { buildRailwayPlan, type RailwayBuild } from './railway-plan.js'

const SECONDS_PER_RAIL = 1.2
const SECONDS_PER_CUT = 0.7

export interface RailwayInput {
  /** The rail cell the line starts at; the bot's own cell when left out. */
  readonly from: Position | undefined
  /** Where it ends: a cell, or the cell a player stands at. */
  readonly to: Position | undefined
  readonly toPlayer: string | undefined
  readonly layout: Layout
  readonly variant: Variant
  /** Economy only: a powered rail every this many rails on level track. */
  readonly spacing: number | undefined
  /** How far below the surface a tunnel runs in the middle. */
  readonly depth: number | undefined
  /** The block laid under a rail where the ground is missing. */
  readonly supportBlock: string
  readonly label: string | undefined
  readonly fetchFromStorage: boolean
  readonly onInventoryFull?: InventoryFullKind | undefined
  /** Walk the finished line and check every rail (build only). */
  readonly verify: boolean
}

export interface RailwayFacts {
  readonly start: Position
  readonly end: Position
  readonly layout: 'surface' | 'underground'
  readonly variant: Variant
  readonly rails: number
  /** Where the line turns, and how many rails are on a slope. */
  readonly corners: readonly Position[]
  readonly slopes: number
  readonly cuts: number
  readonly decks: number
  readonly poweredRails: number
  readonly torches: number
  /** The block set behind the first rail so a cart resting on it starts by itself. */
  readonly buffer: Position | undefined
  readonly notes: readonly string[]
}

export interface RailwayPreview extends PlanPreview, RailwayFacts {
  /** Raw materials to craft what is missing (rails, powered rails, torches). */
  readonly crafting: readonly ItemAmount[]
  readonly estimatedMinutes: number
}

export interface BuildRailwayOutput extends PlanOutcome, RailwayFacts {
  readonly id: string | undefined
  readonly fetched: readonly ItemCount[]
  /** Undefined when the check was switched off. */
  readonly verification: Verification | undefined
}

export interface BuildRailwayDeps {
  readonly planner: RailRoutePlanner
  readonly blocks: BlockScanner
  readonly executor: PlanExecutor
  readonly vitals: VitalsReader
  readonly entities: EntityScanner
  readonly verifier: RailVerifier
  readonly log: RailwayLog
  readonly fetcher?: MaterialFetcher
}

interface Prepared {
  readonly route: RailRoute
  readonly build: RailwayBuild
  readonly facts: RailwayFacts
}

const floorOf = (position: Position): Position => ({
  x: Math.floor(position.x),
  y: Math.floor(position.y),
  z: Math.floor(position.z),
})

/**
 * Plans and builds a railway. The route (where it runs and how high) comes from `RailRoutePlanner`, the steps from
 * `buildRailwayPlan`, and the shared `PlanExecutor` carries them out with the hazard rule on, so a cut that meets lava,
 * water, or a cave ends the line there and says where. Afterwards every rail is checked (shape, power) and what is
 * wrong is put right once.
 */
export class BuildRailwaySkill implements Skill<RailwayInput, BuildRailwayOutput> {
  readonly name = 'build_railway'

  constructor(private readonly deps: BuildRailwayDeps) {}

  preview(input: RailwayInput): SkillResult<RailwayPreview> {
    const prepared = this.prepare(input)
    if (!prepared.ok) return prepared
    const { build, facts } = prepared.value
    const preview = this.deps.executor.preview(build.plan, this.optionsFor(input))
    return ok({
      ...preview,
      ...facts,
      crafting: rawMaterialsFor(preview.missing),
      estimatedMinutes: Math.round(
        (facts.rails * SECONDS_PER_RAIL + facts.cuts * SECONDS_PER_CUT) / 60,
      ),
    })
  }

  async run(input: RailwayInput, context: SkillContext): Promise<SkillResult<BuildRailwayOutput>> {
    const prepared = this.prepare(input)
    if (!prepared.ok) return prepared
    const { build, facts } = prepared.value
    const options = this.optionsFor(input)
    const { executor, fetcher } = this.deps

    const fetched: ItemCount[] = []
    const before = executor.preview(build.plan, options)
    if (before.missing.length > 0 && input.fetchFromStorage && fetcher !== undefined) {
      await fetcher.fetch(before.missing, context)
      fetched.push(...before.missing)
    }

    const done = await executor.run(build.plan, options, context)
    if (!done.ok) {
      const crafting = rawMaterialsFor(
        done.error.reason === 'missing_materials'
          ? executor.preview(build.plan, options).missing
          : [],
      )
      const hint =
        crafting.length === 0
          ? ''
          : ` Crafting what is missing takes ${crafting.map((m) => `${String(m.count)} ${m.name}`).join(', ')}.`
      return err({
        ...done.error,
        message: done.error.message + hint,
        detail: { ...done.error.detail, ...facts },
      })
    }
    const stopped = done.value.ended[0]
    if (stopped !== undefined)
      return err({
        reason: 'line_incomplete',
        message: `The line stopped ${
          stopped.at === undefined
            ? ''
            : `at ${String(stopped.at.x)}, ${String(stopped.at.y)}, ${String(stopped.at.z)} `
        }(${stopped.reason}) with ${String(stopped.skipped)} steps left.`,
        detail: { ended: done.value.ended, ...facts },
      })

    const verification = input.verify
      ? await this.deps.verifier.verify(
          { cells: prepared.value.route.cells, powered: build.powered, torches: build.torches },
          context,
        )
      : undefined
    const logged = this.deps.log.add({
      label: input.label,
      start: facts.start,
      end: facts.end,
      layout: facts.layout,
      variant: facts.variant,
      rails: facts.rails,
    })
    return ok({
      ...done.value,
      ...facts,
      id: logged.ok ? logged.value.id : undefined,
      fetched,
      verification,
    })
  }

  private optionsFor(input: RailwayInput): PlanOptions {
    return {
      clearObstacles: true,
      onInventoryFull: input.onInventoryFull,
      spoil: undefined,
      scaffold: undefined,
    }
  }

  private prepare(input: RailwayInput): SkillResult<Prepared> {
    const spacing = input.spacing ?? ECONOMY_SPACING_DEFAULT
    if (spacing < ECONOMY_SPACING_MIN || spacing > ECONOMY_SPACING_MAX)
      return err({
        reason: 'invalid_spacing',
        message: `Powered rails go every ${String(ECONOMY_SPACING_MIN)} to ${String(ECONOMY_SPACING_MAX)} rails on level track, not ${String(spacing)}.`,
      })
    const here = this.deps.vitals.read()?.position
    if (here === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })

    const planner = this.deps.planner
    const start = input.from === undefined ? floorOf(here) : planner.snap(input.from)
    let destination = input.to
    if (destination === undefined && input.toPlayer !== undefined) {
      const player = this.deps.entities.player(input.toPlayer)
      if (player === undefined)
        return err({ reason: 'player_not_online', message: `${input.toPlayer} is not online.` })
      if (player.position === undefined)
        return err({
          reason: 'player_not_visible',
          message: `${input.toPlayer} is out of view, so where they are is not known. Give the place as coordinates.`,
        })
      destination = floorOf(player.position)
    }
    if (destination === undefined)
      return err({
        reason: 'no_destination',
        message: 'Say where the line goes: to (coordinates) or to_player.',
      })
    const end = input.to === undefined ? destination : planner.snap(destination)

    const routed = planner.plan({ start, end, layout: input.layout, depth: input.depth })
    if (!routed.ok)
      return err({
        reason: routed.error.reason,
        message: routed.error.message,
        ...(routed.error.at === undefined ? {} : { detail: { at: routed.error.at } }),
      })
    const route = routed.value
    const build = buildRailwayPlan(route, this.deps.blocks, {
      variant: input.variant,
      spacing,
      supportBlock: input.supportBlock,
    })
    const cells = route.cells
    const facts: RailwayFacts = {
      start,
      end,
      layout: route.layout,
      variant: input.variant,
      rails: cells.length,
      corners: cells.filter((_, i) => isCorner(cells, i)),
      slopes: cells.filter((cell, i) =>
        [cells[i - 1], cells[i + 1]].some((other) => other !== undefined && other.y !== cell.y),
      ).length,
      cuts: route.cuts,
      decks: route.decks,
      poweredRails: build.powered.length,
      torches: build.torches.length,
      buffer: build.buffer,
      notes: build.notes,
    }
    return ok({ route, build, facts })
  }
}
