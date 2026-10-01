import { z } from 'zod'
import type { Position } from '../../../core/position.types.js'
import type { WorkPlan, WorkStep } from '../../construction/work-plan.types.js'
import { GATE_SIDES, GATE_SIDE_DESCRIPTION, fenceRingSteps, type GateSide } from '../fence-ring.js'
import type { FarmLayoutContext, FarmLayoutProvider } from '../farm-layout.types.js'
import { CROP_NAMES, cropFor } from '../crop-table.js'

const MIN_WIDTH = 3
/** Water hydrates farmland up to 4 blocks away in every direction: one water line (or spot) serves 9 blocks across. */
export const HYDRATION_SPAN = 9
/** Two bands of 9 across: each has its own trench (or its own spots), so a wider field is still watered everywhere. */
const MAX_WIDTH = 2 * HYDRATION_SPAN
const MIN_LENGTH = 3
const MAX_LENGTH = 32

export const WATER_LAYOUTS = ['trench', 'spots'] as const
export type WaterLayout = (typeof WATER_LAYOUTS)[number]

/**
 * The middle of each part a side is cut into, so no part is wider than the reach of one water block. The parts are
 * as equal as they can be (10 cells make two of 5, not 9 and 1), and the centre is the middle cell of a part.
 */
export function waterCentres(size: number): number[] {
  const parts = Math.ceil(size / HYDRATION_SPAN)
  const centres: number[] = []
  for (let part = 0; part < parts; part += 1) {
    const start = Math.floor((part * size) / parts)
    const end = Math.floor(((part + 1) * size) / parts) - 1
    centres.push(start + Math.floor((end - start) / 2))
  }
  return centres
}

/**
 * The plots of a `width` by `length` field (0-based, x across, z along) that hold water. `trench`: a line down the
 * middle of every 9-wide band, over the whole length, so every plot is within 4 blocks of water however long the field
 * is. `spots`: one block at the centre of each 9 by 9 part. Neither ever puts a lone block at the edge of the field.
 */
export function waterPlots(
  width: number,
  length: number,
  layout: WaterLayout,
): { readonly i: number; readonly j: number }[] {
  const across = waterCentres(width)
  if (layout === 'spots') {
    const along = waterCentres(length)
    return across.flatMap((i) => along.map((j) => ({ i, j })))
  }
  return across.flatMap((i) => Array.from({ length }, (_, j) => ({ i, j })))
}

/**
 * A stem crop (pumpkin) grows its fruit on a free cell beside the stem, so every second row along the field stays
 * untilled: rows 0, 2, 4... hold stems, rows 1, 3, 5... are left free (grass or dirt, nothing above) for the fruit.
 * Rows run across the field (along x), so whatever the water layout, every stem has a free row next to it.
 */
export const isFreeRow = (j: number): boolean => j % 2 === 1

const cropFieldParams = z.object({
  width: z
    .number()
    .int()
    .min(MIN_WIDTH)
    .max(MAX_WIDTH)
    .describe(
      `Across the field, x axis (${String(MIN_WIDTH)} to ${String(MAX_WIDTH)}): every ${String(HYDRATION_SPAN)} blocks across get their own water.`,
    ),
  length: z
    .number()
    .int()
    .min(MIN_LENGTH)
    .max(MAX_LENGTH)
    .describe(`Along the field, z axis (${String(MIN_LENGTH)} to ${String(MAX_LENGTH)}).`),
  crop: z
    .enum(CROP_NAMES)
    .describe(
      `What to plant: ${CROP_NAMES.join(', ')}. Pumpkin and melon are planted in every second row only (the rows between are left free for the fruit); pumpkin seeds come from crafting a pumpkin, melon seeds from a melon slice.`,
    ),
  fence: z.boolean().default(true).describe('Build a fence with a gate around the field.'),
  torches: z
    .boolean()
    .default(true)
    .describe('Light the fence posts so mobs cannot spawn on the field at night.'),
  gate_side: z.enum(GATE_SIDES).default('south').describe(GATE_SIDE_DESCRIPTION),
  water: z
    .enum(WATER_LAYOUTS)
    .default('trench')
    .describe(
      '"trench" (default): a line of water blocks down the middle over the whole length (one line per 9 blocks of width), so every plot is within 4 blocks of water; it takes one water bucket per block of it. "spots": one water block at the centre of each 9 by 9 part of the field, far fewer buckets (a field up to 9x9 needs one).',
    ),
})

type CropFieldParams = z.output<typeof cropFieldParams>

/**
 * A tilled, watered, fenced crop field. Every plot the field itself does not use for the water channel is tilled,
 * ready for a crop. Planting the field (and tending it afterwards: harvesting, replanting) is `plant_crops`/
 * `harvest_crops`, not this provider (see docs/features/farming/crop-farming.md: layout is building, tending is not) — `BuildFarmSkill` calls
 * `plant_crops` itself right after a successful build, so "build me a wheat farm" still plants it in one call.
 * Planting is kept out of this WorkPlan on purpose: a `place` step reserves its cell for the whole run, and a dense
 * grid of reserved seed cells one block above every tilled plot left the standing-spot search with nowhere to put
 * the bot for the plots in the middle of the field (found while building this feature's own e2e test).
 */
export class CropFieldProvider implements FarmLayoutProvider<CropFieldParams> {
  readonly kind = 'field'
  readonly description =
    'A tilled, watered, fenced crop field: `width` (x) by `length` (z), starting at the lowest x/z corner (by ' +
    'default the ground block two blocks east of the bot). `water` picks the layout: "trench" (default) is a line ' +
    'of water down the middle (one line per 9 blocks of width), "spots" one block at the centre of each 9x9 part; ' +
    'either way every plot is within 4 blocks of water, and no lone block goes at an edge. Each water block takes ' +
    'one filled water bucket (fill_bucket makes them), so the preview says how many are needed. ' +
    'build_farm plants the chosen crop over the field right after building it. `gate_side` (north, south, east, ' +
    'west; default south) puts the gate in the middle of that side; a pen takes the same option. `crop: pumpkin` ' +
    'or `crop: melon` makes a stem field: stems go in every second row and the rows between stay free for the fruit to grow ' +
    'into (harvest_crops takes the pumpkins or melons and leaves the stems). Needs a hoe, water buckets, and fence.'
  readonly params = cropFieldParams

  defaultOrigin(feet: Position): Position {
    return { x: Math.floor(feet.x) + 2, y: Math.floor(feet.y) - 1, z: Math.floor(feet.z) }
  }

  cropOf(params: CropFieldParams): string {
    return params.crop
  }

  gateSideOf(params: CropFieldParams): GateSide | undefined {
    return params.fence ? params.gate_side : undefined
  }

  generate(p: CropFieldParams, context: FarmLayoutContext): WorkPlan | { error: string } {
    const spec = cropFor(p.crop)?.spec
    if (spec === undefined) return { error: `${p.crop} is not a crop this can plant.` }
    const { x: x0, y: y0, z: z0 } = context.origin
    const water = new Set(
      waterPlots(p.width, p.length, p.water).map(({ i, j }) => `${String(i)},${String(j)}`),
    )
    // Water first: the executor takes the first step it can do, and farmland tilled before there is water near it
    // turns back into dirt on a random tick (about once a minute), which on a big field happens before the last plots
    // are tilled.
    const wet: WorkStep[] = []
    const tilled: WorkStep[] = []
    for (let i = 0; i < p.width; i += 1) {
      for (let j = 0; j < p.length; j += 1) {
        const ground = { x: x0 + i, y: y0, z: z0 + j }
        if (water.has(`${String(i)},${String(j)}`))
          wet.push({ kind: 'place', at: ground, block: 'water_bucket', branch: 'channel' })
        else if (spec.kind === 'stem' && isFreeRow(j)) continue
        else tilled.push({ kind: 'till', at: ground, branch: 'field' })
      }
    }
    const steps: WorkStep[] = [...wet, ...tilled]
    if (p.fence)
      steps.push(
        ...fenceRingSteps({
          x0,
          y0,
          z0,
          width: p.width,
          length: p.length,
          torches: p.torches,
          gateSide: p.gate_side,
        }),
      )
    return {
      name: `${p.crop} field ${String(p.width)}x${String(p.length)}`,
      steps,
      standing: 'inside',
    }
  }
}
