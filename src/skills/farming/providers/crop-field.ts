import { z } from 'zod'
import type { Position } from '../../../core/position.types.js'
import type { WorkPlan, WorkStep } from '../../construction/work-plan.types.js'
import type { FarmLayoutContext, FarmLayoutProvider } from '../farm-layout.types.js'
import { CROP_NAMES, classifyCrop } from '../crop-table.js'

const MIN_WIDTH = 3
/** A single water channel down the centre column hydrates farmland up to 4 blocks either side: 9 wide reaches both edges. */
const MAX_WIDTH = 9
const MIN_LENGTH = 3
const MAX_LENGTH = 32
/** How far apart the water sources are set into the channel; each hydrates farmland up to 4 blocks away along it too. */
const CHANNEL_SPACING = 8
/** How many fence posts apart a torch goes, so the field is lit against mob spawns without one on every post. */
const TORCH_SPACING = 5

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
 * `harvest_crops`, not this provider (see AGENTS.md: layout is building, tending is not) — `BuildFarmSkill` calls
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
    if (p.fence) steps.push(...fenceSteps(x0, y0, z0, p.width, p.length, p.torches))
    return {
      name: `${p.crop} field ${String(p.width)}x${String(p.length)}`,
      steps,
      standing: 'inside',
    }
  }
}

/** A fence ring one cell outside the footprint, one gate in the middle of the south side, torches along the way. */
function fenceSteps(
  x0: number,
  y0: number,
  z0: number,
  width: number,
  length: number,
  torches: boolean,
): WorkStep[] {
  const west = x0 - 1
  const east = x0 + width
  const north = z0 - 1
  const south = z0 + length
  const gateX = x0 + Math.floor((width - 1) / 2)
  const perimeter: { readonly x: number; readonly z: number; readonly gate: boolean }[] = []
  for (let x = west; x <= east; x += 1) perimeter.push({ x, z: north, gate: false })
  for (let z = north + 1; z <= south; z += 1) perimeter.push({ x: east, z, gate: false })
  for (let x = east - 1; x >= west; x -= 1)
    perimeter.push({ x, z: south, gate: x === gateX })
  for (let z = south - 1; z > north; z -= 1) perimeter.push({ x: west, z, gate: false })

  const steps: WorkStep[] = []
  let post = 0
  for (const cell of perimeter) {
    if (cell.gate) {
      steps.push({
        kind: 'place',
        at: { x: cell.x, y: y0 + 1, z: cell.z },
        block: 'oak_fence_gate',
        alignAxis: 'x',
        branch: 'fence',
      })
      continue
    }
    steps.push({
      kind: 'place',
      at: { x: cell.x, y: y0 + 1, z: cell.z },
      block: 'oak_fence',
      branch: 'fence',
    })
    if (torches && post % TORCH_SPACING === 0)
      steps.push({
        kind: 'light',
        at: { x: cell.x, y: y0 + 2, z: cell.z },
        minLight: 8,
        spacing: TORCH_SPACING,
        branch: 'fence',
      })
    post += 1
  }
  return steps
}
