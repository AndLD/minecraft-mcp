import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { EntityScanner } from '../../core/entity-scanner.port.js'
import { countItems, gained } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { InventoryFullKind } from '../../state/storage-policy.js'
import type { MaterialFetcher } from '../building/material-fetcher.js'
import type { PlanExecutor, PlanOptions } from '../construction/plan-executor.js'
import { feetCell, type Direction } from '../excavation/providers/geometry.js'
import { directionFromYaw, rectangleFromFacing, type Rectangle } from './facing.js'
import { buildCutPlan, buildFillPlan, surveyFill } from './flatten-plan.js'
import { surveyHeights, type HeightSurvey } from './height-survey.js'
import type { MarkerFinder } from './marker-finder.js'
import { pickFillBlock } from './natural-terrain.js'

/** No side over this many blocks (4096 columns at most). */
const MAX_SIDE = 64
/** How far above and below the player's own feet the height survey looks. */
const SURVEY_REACH = 30

export interface FlattenAreaInput {
  readonly player: string
  readonly width?: number | undefined
  readonly length?: number | undefined
  readonly origin?: { readonly x: number; readonly z: number } | undefined
  readonly direction?: Direction | undefined
  readonly markerBlocks?: readonly string[] | undefined
  readonly level: 'here' | 'y' | 'markers' | 'auto'
  readonly y?: number | undefined
  readonly clearHeight: number
  readonly fillBlock?: string | undefined
  readonly surfaceBlock?: string | undefined
  readonly margin: number
  readonly clearTrees: boolean
  readonly maxFillDepth: number
  readonly clearStructures: boolean
  readonly spoilPolicy?: 'storage' | 'discard_junk' | undefined
  readonly onInventoryFull?: InventoryFullKind | undefined
  readonly fetchFromStorage: boolean
}

export interface FlattenAreaOutput {
  readonly bounds: { readonly from: Position; readonly to: Position }
  readonly level: number
  readonly cut: number
  readonly cleared: number
  readonly filled: number
  readonly fillBlock: string
  readonly blockedCells: readonly Position[]
  readonly tooDeep: readonly Position[]
  readonly gained: readonly ItemCount[]
  readonly fetched: readonly ItemCount[]
}

export interface FlattenPreview {
  readonly bounds: { readonly from: Position; readonly to: Position }
  readonly level: number
  readonly direction: Direction
  readonly usedMarkersForArea: boolean
  readonly toCut: number
  readonly toClear: number
  readonly fillColumns: number
  readonly toFill: number
  readonly blockedCells: readonly Position[]
  readonly blockedCount: number
  readonly tooDeep: readonly Position[]
  /** Only when `level: "auto"`: the suggested level and, for comparison, the cost of using the player's own level. */
  readonly suggestion?: {
    readonly level: number
    readonly hereLevel: number
    readonly hereCut: number
    readonly hereFill: number
  }
}

export interface FlattenAreaDeps {
  readonly blocks: BlockScanner
  readonly entities: EntityScanner
  readonly vitals: VitalsReader
  readonly inventory: InventoryReader
  readonly executor: PlanExecutor
  readonly markers: MarkerFinder
  readonly fetcher?: MaterialFetcher | undefined
}

interface Prepared {
  readonly rect: Rectangle
  readonly direction: Direction
  readonly usedMarkersForArea: boolean
  readonly level: number
  readonly survey: HeightSurvey
  readonly hereY: number
}

/**
 * Levels a rectangle of ground to one height: cuts what is above it, fills what is below, clears what grows there.
 * A thin client of the construction engine: cutting and filling are each a `WorkPlan` the shared `PlanExecutor`
 * carries out, in two passes so material the cut turns up (dirt, cobblestone, sand) can be reused as fill.
 */
export class FlattenAreaSkill implements Skill<FlattenAreaInput, FlattenAreaOutput> {
  readonly name = 'flatten_area'

  constructor(private readonly deps: FlattenAreaDeps) {}

  preview(input: FlattenAreaInput): SkillResult<FlattenPreview> {
    const prepared = this.prepare(input)
    if (!prepared.ok) return prepared
    const { rect, direction, usedMarkersForArea, level, survey, hereY } = prepared.value

    const cut = buildCutPlan(
      this.deps.blocks,
      rect,
      level,
      input.clearHeight,
      input.clearTrees,
      input.clearStructures,
    )
    const fill = surveyFill(survey, rect, level, input.maxFillDepth)
    const toFill = fill.fillable.reduce((total, column) => total + (level - column.groundY), 0)

    let suggestion: FlattenPreview['suggestion']
    if (input.level === 'auto') {
      const hereCost = this.costAt(rect, hereY, input)
      suggestion = { level, hereLevel: hereY, hereCut: hereCost.cut, hereFill: hereCost.fill }
    }

    return ok({
      bounds: boundsOf(rect, level),
      level,
      direction,
      usedMarkersForArea,
      toCut: cut.cutCount,
      toClear: cut.clearedCount,
      fillColumns: fill.fillable.length,
      toFill,
      blockedCells: cut.blockedCells,
      blockedCount: cut.blockedCells.length,
      tooDeep: fill.tooDeep,
      suggestion,
    })
  }

  async run(
    input: FlattenAreaInput,
    context: SkillContext,
  ): Promise<SkillResult<FlattenAreaOutput>> {
    if (input.level === 'auto')
      return err({
        reason: 'ambiguous_level',
        message:
          'level: "auto" only suggests a level (call preview_flatten to see it); give an explicit y to actually flatten.',
      })
    const prepared = this.prepare(input)
    if (!prepared.ok) return prepared
    const { rect, level, survey } = prepared.value
    const { deps } = this

    const options: PlanOptions = {
      clearObstacles: input.clearStructures,
      onInventoryFull: input.onInventoryFull,
      spoil: input.spoilPolicy,
      scaffold: undefined,
    }

    const cut = buildCutPlan(
      deps.blocks,
      rect,
      level,
      input.clearHeight,
      input.clearTrees,
      input.clearStructures,
    )
    const before = countItems(deps.inventory.snapshot())
    const cutResult = await deps.executor.run(cut.plan, options, context)
    if (!cutResult.ok) return err(cutResult.error)

    const afterCut = countItems(deps.inventory.snapshot())
    const cutGained = gained(before, afterCut)
    const fillBlock = input.fillBlock ?? pickFillBlock(cutGained)

    const fillSurvey = surveyFill(survey, rect, level, input.maxFillDepth)
    const fillPlan = buildFillPlan(rect, fillSurvey.fillable, level, fillBlock, input.surfaceBlock)

    const fetched: ItemCount[] = []
    if (input.fetchFromStorage && deps.fetcher !== undefined) {
      const needed = deps.executor.preview(fillPlan, options).missing
      if (needed.length > 0) {
        await deps.fetcher.fetch(needed, context)
        fetched.push(...needed)
      }
    }

    const fillResult = await deps.executor.run(fillPlan, options, context)
    if (!fillResult.ok)
      return err({ ...fillResult.error, detail: { ...fillResult.error.detail, cutDone: true } })

    return ok({
      bounds: boundsOf(rect, level),
      level,
      cut: cut.cutCount,
      cleared: cut.clearedCount,
      filled: fillResult.value.placed,
      fillBlock,
      blockedCells: cut.blockedCells,
      tooDeep: fillSurvey.tooDeep,
      gained: gained(before, countItems(deps.inventory.snapshot())),
      fetched,
    })
  }

  /** The cut and fill block counts at a given level, without changing anything (used to compare `here` to `auto`). */
  private costAt(
    rect: Rectangle,
    level: number,
    input: FlattenAreaInput,
  ): { cut: number; fill: number } {
    const cut = buildCutPlan(
      this.deps.blocks,
      rect,
      level,
      input.clearHeight,
      input.clearTrees,
      true, // for the comparison, count everything above the level, not only what would actually be cleared
    )
    const survey = surveyHeights(this.deps.blocks, rect, level + SURVEY_REACH, level - SURVEY_REACH)
    const fill = surveyFill(survey, rect, level, input.maxFillDepth)
    const toFill = fill.fillable.reduce((total, column) => total + (level - column.groundY), 0)
    return { cut: cut.cutCount + cut.clearedCount, fill: toFill }
  }

  private prepare(input: FlattenAreaInput): SkillResult<Prepared> {
    const { deps } = this
    const vitals = deps.vitals.read()
    if (vitals === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
    const player = deps.entities.player(input.player)
    if (player === undefined)
      return err({
        reason: 'player_not_online',
        message: `${input.player} is not online.`,
      })
    if (player.position === undefined)
      return err({
        reason: 'player_not_visible',
        message: `${input.player} is too far away for the bot to see.`,
      })

    const position = player.position
    let markers: { readonly a: Position; readonly b: Position } | undefined
    const findMarkers = (): SkillResult<{ readonly a: Position; readonly b: Position }> => {
      if (markers !== undefined) return ok(markers)
      const found = deps.markers.find(position, { markerBlocks: input.markerBlocks })
      if (!found.ok)
        return err({
          reason: 'markers_not_found',
          message:
            found.found.length === 0
              ? 'No corner markers found: place two vertical, two-block-high stacks of dirt or cobblestone at opposite corners of the plot.'
              : `Only one marker stack was found; a plot needs two, at opposite corners.`,
          detail: { found: found.found },
        })
      markers = { a: found.a, b: found.b }
      return ok(markers)
    }

    let rect: Rectangle
    let direction: Direction
    let usedMarkersForArea = false
    const facingDirection = player.yaw === undefined ? 'north' : directionFromYaw(player.yaw)
    if (input.width !== undefined && input.length !== undefined) {
      const start = input.origin ?? feetCell(position)
      direction = input.direction ?? facingDirection
      rect = rectangleFromFacing(start, direction, input.width, input.length)
    } else {
      const found = findMarkers()
      if (!found.ok) return found
      rect = {
        x1: Math.min(found.value.a.x, found.value.b.x),
        z1: Math.min(found.value.a.z, found.value.b.z),
        x2: Math.max(found.value.a.x, found.value.b.x),
        z2: Math.max(found.value.a.z, found.value.b.z),
      }
      direction = facingDirection
      usedMarkersForArea = true
    }
    rect = {
      x1: rect.x1 - input.margin,
      z1: rect.z1 - input.margin,
      x2: rect.x2 + input.margin,
      z2: rect.z2 + input.margin,
    }
    const width = rect.x2 - rect.x1 + 1
    const length = rect.z2 - rect.z1 + 1
    if (width > MAX_SIDE || length > MAX_SIDE || width * length > MAX_SIDE * MAX_SIDE)
      return err({
        reason: 'too_large',
        message: `That plot is ${String(width)}x${String(length)}; each side is limited to ${String(MAX_SIDE)}.`,
      })

    const hereY = feetCell(position).y - 1
    const survey = surveyHeights(deps.blocks, rect, hereY + SURVEY_REACH, hereY - SURVEY_REACH)

    let level: number
    if (input.level === 'here') level = hereY
    else if (input.level === 'auto') level = survey.median
    else if (input.level === 'y') {
      if (input.y === undefined)
        return err({ reason: 'missing_level', message: 'Give an explicit y for level: "y".' })
      level = input.y
    } else {
      const found = findMarkers()
      if (!found.ok) return found
      level = Math.min(found.value.a.y, found.value.b.y)
    }

    return ok({ rect, direction, usedMarkersForArea, level, survey, hereY })
  }
}

const boundsOf = (rect: Rectangle, level: number): { from: Position; to: Position } => ({
  from: { x: rect.x1, y: level, z: rect.z1 },
  to: { x: rect.x2, y: level, z: rect.z2 },
})
