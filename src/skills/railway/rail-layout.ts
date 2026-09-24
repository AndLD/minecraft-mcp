import type { Position } from '../../core/position.types.js'
import { isCorner } from './rail-orientation.js'
import { RICH_TORCH_SPACING, SLOPE_SPACING, START_RUN } from './rail-table.js'

export type Variant = 'economy' | 'rich'

export interface PowerLayout {
  /** Which cells are powered rails; the rest are plain rails. */
  readonly powered: ReadonlySet<number>
  /** Which powered rails carry a redstone torch. */
  readonly torches: ReadonlySet<number>
}

/** A rail that goes up or down towards either neighbour. */
const onSlope = (cells: readonly Position[], index: number): boolean => {
  const here = cells[index]
  if (here === undefined) return false
  return [cells[index - 1], cells[index + 1]].some(
    (other) => other !== undefined && other.y !== here.y,
  )
}

/**
 * Which rails are powered, and which of those get a torch.
 *
 * - `economy`: the first few rails (they start a cart resting on them), then one every `spacing` on level track and
 *   every 3 on a slope, never on a corner (a powered rail cannot bend); each run has its own torch.
 * - `rich`: every rail that is not a corner. Power passes along a run of powered rails, so a torch on the first of
 *   each run and then one every 9 does, and a corner (plain rail) starts a new run.
 */
export function assignPower(
  cells: readonly Position[],
  variant: Variant,
  spacing: number,
): PowerLayout {
  const powered = new Set<number>()
  const torches = new Set<number>()
  if (variant === 'economy') {
    let last = -Infinity
    for (let i = 0; i < cells.length; i += 1) {
      if (isCorner(cells, i)) continue
      const gap = onSlope(cells, i) ? SLOPE_SPACING : spacing
      // A cart resting on the first rail has to get up to speed before the plain rails: the start is a short run of
      // powered rails (one torch feeds them all), not a single one.
      const inStartRun = i < START_RUN && (i === 0 || powered.has(i - 1))
      if (inStartRun || i - last >= gap) {
        powered.add(i)
        if (!powered.has(i - 1)) torches.add(i)
        last = i
      }
    }
    return { powered, torches }
  }
  let run = 0
  for (let i = 0; i < cells.length; i += 1) {
    if (isCorner(cells, i)) {
      run = 0
      continue
    }
    powered.add(i)
    if (run % RICH_TORCH_SPACING === 0) torches.add(i)
    run += 1
  }
  return { powered, torches }
}
