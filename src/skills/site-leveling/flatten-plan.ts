import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Position } from '../../core/position.types.js'
import type { WorkPlan, WorkStep } from '../construction/work-plan.types.js'
import type { Rectangle } from './facing.js'
import type { HeightSurvey } from './height-survey.js'
import { isNaturalTerrain, isTreePart, isVegetation } from './natural-terrain.js'

const key = (x: number, z: number): string => `${String(x)},${String(z)}`

export interface CutPlan {
  readonly plan: WorkPlan
  /** Player-made cells above the level, left alone because `clearStructures` was not asked for. */
  readonly blockedCells: readonly Position[]
  readonly cutCount: number
  readonly clearedCount: number
}

export interface FillColumn {
  readonly x: number
  readonly z: number
  readonly groundY: number
}

export interface SurveyedFill {
  readonly fillable: readonly FillColumn[]
  /** Columns whose hole is deeper than `maxFillDepth`: left as they are. */
  readonly tooDeep: readonly Position[]
}

/**
 * The break steps that level the ground down to `level`: everything from `level + 1` up to `level + clearHeight`,
 * top down so nothing falls on the bot. Natural stone and soil counts as `cut` (it shapes the ground itself);
 * vegetation and, with `clearTrees`, logs and leaves count as `cleared` (they only grow on top of it). A
 * player-made block in that range is only broken when `clearStructures` is true (counted as `cleared` too);
 * otherwise it is reported as blocked, not touched.
 */
export function buildCutPlan(
  blocks: BlockScanner,
  rect: Rectangle,
  level: number,
  clearHeight: number,
  clearTrees: boolean,
  clearStructures: boolean,
): CutPlan {
  const steps: WorkStep[] = []
  const blockedCells: Position[] = []
  let cutCount = 0
  let clearedCount = 0

  for (let y = level + clearHeight; y > level; y -= 1) {
    for (let x = rect.x1; x <= rect.x2; x += 1) {
      for (let z = rect.z1; z <= rect.z2; z += 1) {
        const at = { x, y, z }
        const name = blocks.blockAt(at)
        if (name === undefined || name === 'air') continue
        const natural = isNaturalTerrain(name)
        const growth = isVegetation(name) || (clearTrees && isTreePart(name))
        if (!natural && !growth && !clearStructures) {
          blockedCells.push(at)
          continue
        }
        steps.push({ kind: 'break', at })
        if (natural) cutCount += 1
        else clearedCount += 1
      }
    }
  }

  return {
    plan: {
      name: `flatten ${String(rect.x2 - rect.x1 + 1)}x${String(rect.z2 - rect.z1 + 1)} to y=${String(level)}: cut`,
      steps,
      standing: 'outside',
      hazards: 'refuse',
    },
    blockedCells,
    cutCount,
    clearedCount,
  }
}

/** Which columns need filling to reach `level`, and which are too deep a hole for `maxFillDepth`. */
export function surveyFill(
  survey: HeightSurvey,
  rect: Rectangle,
  level: number,
  maxFillDepth: number,
): SurveyedFill {
  const fillable: FillColumn[] = []
  const tooDeep: Position[] = []
  for (let x = rect.x1; x <= rect.x2; x += 1) {
    for (let z = rect.z1; z <= rect.z2; z += 1) {
      const groundY = survey.heights.get(key(x, z))
      if (groundY === undefined || groundY >= level) continue
      if (level - groundY > maxFillDepth) tooDeep.push({ x, y: groundY, z })
      else fillable.push({ x, z, groundY })
    }
  }
  return { fillable, tooDeep }
}

/** The place steps that fill every column in `fillable` up to `level`, bottom up, with `fillBlock`. */
export function buildFillPlan(
  rect: Rectangle,
  fillable: readonly FillColumn[],
  level: number,
  fillBlock: string,
  surfaceBlock: string | undefined,
): WorkPlan {
  const steps: WorkStep[] = []
  for (const column of fillable) {
    for (let y = column.groundY + 1; y <= level; y += 1) {
      const block = y === level && surfaceBlock !== undefined ? surfaceBlock : fillBlock
      steps.push({ kind: 'place', at: { x: column.x, y, z: column.z }, block })
    }
  }
  return {
    name: `flatten ${String(rect.x2 - rect.x1 + 1)}x${String(rect.z2 - rect.z1 + 1)} to y=${String(level)}: fill`,
    steps,
    standing: 'outside',
    hazards: 'refuse',
  }
}
