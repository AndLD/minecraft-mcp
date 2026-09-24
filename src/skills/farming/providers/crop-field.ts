import { z } from 'zod'
import type { Position } from '../../../core/position.types.js'
import type { WorkPlan, WorkStep } from '../../construction/work-plan.types.js'
import { fenceRingSteps } from '../fence-ring.js'
import type { FarmLayoutContext, FarmLayoutProvider } from '../farm-layout.types.js'
import { CROP_NAMES, classifyCrop } from '../crop-table.js'

const MIN_WIDTH = 3
/** A single water channel down the centre column hydrates farmland up to 4 blocks either side: 9 wide reaches both edges. */
const MAX_WIDTH = 9
const MIN_LENGTH = 3
const MAX_LENGTH = 32
/** How far apart the water sources are set into the channel; each hydrates farmland up to 4 blocks away along it too. */
const CHANNEL_SPACING = 8

const cropFieldParams = z.object({
  width: z
    .number()
    .int()
    .min(MIN_WIDTH)
    .max(MAX_WIDTH)
    .describe(
      `Across the field, x axis (${String(MIN_WIDTH)} to ${String(MAX_WIDTH)}): capped so a single water channel down the middle reaches every row.`,
    ),
  length: z
    .number()
    .int()
    .min(MIN_LENGTH)
    .max(MAX_LENGTH)
    .describe(`Along the field, z axis (${String(MIN_LENGTH)} to ${String(MAX_LENGTH)}).`),
  crop: z.enum(CROP_NAMES).describe(`What to plant: ${CROP_NAMES.join(', ')}.`),
  fence: z.boolean().default(true).describe('Build a fence with a gate around the field.'),
  torches: z
    .boolean()
    .default(true)
    .describe('Light the fence posts so mobs cannot spawn on the field at night.'),
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
    'default the ground block two blocks east of the bot). A water source is set into the field every ' +
    `${String(CHANNEL_SPACING)} rows down the centre column so every plot is within 4 blocks of water. ` +
    'build_farm plants the chosen crop over the field right after building it. Needs a hoe, water buckets, and fence.'
  readonly params = cropFieldParams

  defaultOrigin(feet: Position): Position {
    return { x: Math.floor(feet.x) + 2, y: Math.floor(feet.y) - 1, z: Math.floor(feet.z) }
  }

  cropOf(params: CropFieldParams): string {
    return params.crop
  }

  generate(p: CropFieldParams, context: FarmLayoutContext): WorkPlan | { error: string } {
    if (classifyCrop(p.crop) === undefined) return { error: `${p.crop} is not a crop this can plant.` }
    const { x: x0, y: y0, z: z0 } = context.origin
    const centerX = Math.floor((p.width - 1) / 2)
    const steps: WorkStep[] = []
    for (let i = 0; i < p.width; i += 1) {
      for (let j = 0; j < p.length; j += 1) {
        const ground = { x: x0 + i, y: y0, z: z0 + j }
        if (i === centerX && j % CHANNEL_SPACING === 0)
          steps.push({ kind: 'place', at: ground, block: 'water_bucket', branch: 'channel' })
        else steps.push({ kind: 'till', at: ground, branch: 'field' })
      }
    }
    if (p.fence)
      steps.push(
        ...fenceRingSteps({ x0, y0, z0, width: p.width, length: p.length, torches: p.torches }),
      )
    return {
      name: `${p.crop} field ${String(p.width)}x${String(p.length)}`,
      steps,
      standing: 'inside',
    }
  }
}
