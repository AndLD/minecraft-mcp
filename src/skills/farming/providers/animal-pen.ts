import { z } from 'zod'
import type { Position } from '../../../core/position.types.js'
import type { WorkPlan, WorkStep } from '../../construction/work-plan.types.js'
import { fenceRingSteps } from '../fence-ring.js'
import type { FarmLayoutContext, FarmLayoutProvider } from '../farm-layout.types.js'
import { PENNABLE_SPECIES } from '../animal-table.js'

const MIN_SIDE = 3
const MAX_SIDE = 12

const animalPenParams = z.object({
  width: z.number().int().min(MIN_SIDE).max(MAX_SIDE).describe(`Across the pen, x axis (${String(MIN_SIDE)} to ${String(MAX_SIDE)}).`),
  length: z.number().int().min(MIN_SIDE).max(MAX_SIDE).describe(`Along the pen, z axis (${String(MIN_SIDE)} to ${String(MAX_SIDE)}).`),
  species: z.enum(PENNABLE_SPECIES).describe(`What the pen is for: ${PENNABLE_SPECIES.join(', ')}.`),
  water: z.boolean().default(false).describe('Put a water source in the middle of the pen.'),
  torches: z
    .boolean()
    .default(true)
    .describe('Light the fence posts so mobs cannot spawn inside the pen at night.'),
})

type AnimalPenParams = z.output<typeof animalPenParams>

/** How many animals a pen of this footprint is meant to hold: a simple one-per-block figure, not vanilla's raw entity-cramming limit (which is about several entities sharing one exact block, not a spread-out pen). */
export function penCapacity(width: number, length: number): number {
  return width * length
}

/**
 * A fenced pen with a gate, for one animal species. Stocking it (`lure_animals`), breeding it (`breed_animals`),
 * and keeping its herd at a target size (`tend_farm`) are plain skills, not this provider (see docs/features/farming/crop-farming.md: layout is
 * building, tending is not) — a pen the player fenced by hand works exactly the same way once `register_farm`
 * points it out.
 */
export class AnimalPenProvider implements FarmLayoutProvider<AnimalPenParams> {
  readonly kind = 'pen'
  readonly description =
    'A fenced pen with a gate for one animal species: `width` (x) by `length` (z), starting at the lowest x/z ' +
    'corner (by default the ground block two blocks east of the bot). Holds about ' +
    `${String(penCapacity(MIN_SIDE, MIN_SIDE))} to ${String(penCapacity(MAX_SIDE, MAX_SIDE))} animals depending on size ` +
    '(one per block of floor, a simple figure, not the exact vanilla cramming limit). Needs fence and, with water, a water bucket.'
  readonly params = animalPenParams

  defaultOrigin(feet: Position): Position {
    return { x: Math.floor(feet.x) + 2, y: Math.floor(feet.y) - 1, z: Math.floor(feet.z) }
  }

  speciesOf(params: AnimalPenParams): string {
    return params.species
  }

  generate(p: AnimalPenParams, context: FarmLayoutContext): WorkPlan | { error: string } {
    const { x: x0, y: y0, z: z0 } = context.origin
    const steps: WorkStep[] = [
      ...fenceRingSteps({ x0, y0, z0, width: p.width, length: p.length, torches: p.torches }),
    ]
    if (p.water) {
      const center = { x: x0 + Math.floor((p.width - 1) / 2), y: y0, z: z0 + Math.floor((p.length - 1) / 2) }
      steps.push({ kind: 'place', at: center, block: 'water_bucket', branch: 'water' })
    }
    return {
      name: `${p.species} pen ${String(p.width)}x${String(p.length)}`,
      steps,
      standing: 'inside',
    }
  }
}
