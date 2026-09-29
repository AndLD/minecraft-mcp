import { z } from 'zod'
import type { Position } from '../../../core/position.types.js'
import type { WorkPlan, WorkStep } from '../../construction/work-plan.types.js'
import { isOpenAir, isReplaceable } from '../../construction/block-match.js'
import { isClearable } from '../../site-leveling/natural-terrain.js'
import { GATE_SIDES, GATE_SIDE_DESCRIPTION, fenceRingSteps, type GateSide } from '../fence-ring.js'
import type { FarmLayoutContext, FarmLayoutProvider } from '../farm-layout.types.js'
import { PENNABLE_SPECIES } from '../animal-table.js'

const MIN_SIDE = 3
const MAX_SIDE = 12

const animalPenParams = z.object({
  width: z
    .number()
    .int()
    .min(MIN_SIDE)
    .max(MAX_SIDE)
    .describe(`Across the pen, x axis (${String(MIN_SIDE)} to ${String(MAX_SIDE)}).`),
  length: z
    .number()
    .int()
    .min(MIN_SIDE)
    .max(MAX_SIDE)
    .describe(`Along the pen, z axis (${String(MIN_SIDE)} to ${String(MAX_SIDE)}).`),
  species: z
    .enum(PENNABLE_SPECIES)
    .describe(`What the pen is for: ${PENNABLE_SPECIES.join(', ')}.`),
  gate_side: z.enum(GATE_SIDES).default('south').describe(GATE_SIDE_DESCRIPTION),
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
    '(one per block of floor, a simple figure, not the exact vanilla cramming limit). Needs fence and, with water, a water bucket. `gate_side` puts the gate in the middle of the north, south (default), east, or west side.'
  readonly params = animalPenParams

  defaultOrigin(feet: Position): Position {
    return { x: Math.floor(feet.x) + 2, y: Math.floor(feet.y) - 1, z: Math.floor(feet.z) }
  }

  speciesOf(params: AnimalPenParams): string {
    return params.species
  }

  gateSideOf(params: AnimalPenParams): GateSide {
    return params.gate_side
  }

  generate(p: AnimalPenParams, context: FarmLayoutContext): WorkPlan | { error: string } {
    const { x: x0, y: y0, z: z0 } = context.origin
    const { clearing, kept } = this.interior(p, context)
    const steps: WorkStep[] = [
      ...clearing,
      ...fenceRingSteps({
        x0,
        y0,
        z0,
        width: p.width,
        length: p.length,
        torches: p.torches,
        gateSide: p.gate_side,
      }),
    ]
    if (p.water) {
      const center = {
        x: x0 + Math.floor((p.width - 1) / 2),
        y: y0,
        z: z0 + Math.floor((p.length - 1) / 2),
      }
      steps.push({ kind: 'place', at: center, block: 'water_bucket', branch: 'water' })
    }
    return {
      name: `${p.species} pen ${String(p.width)}x${String(p.length)}`,
      steps,
      standing: 'inside',
      ...(kept.length === 0
        ? {}
        : {
            warnings: [
              `${String(kept.length)} cell(s) inside the pen hold something the bot will not clear on its own (${[...new Set(kept)].join(', ')}): animals cannot use them.`,
            ],
          }),
    }
  }

  /**
   * On uneven ground the interior keeps grass and dirt at fence level, and animals cannot stand in those cells. They
   * are dug away as part of the build, before the pen's protected area exists (afterwards nothing may dig there).
   * Only natural ground and plants are cleared; anything else found inside (a chest, a wall) is left and reported.
   */
  private interior(
    p: AnimalPenParams,
    context: FarmLayoutContext,
  ): { clearing: WorkStep[]; kept: string[] } {
    const clearing: WorkStep[] = []
    const kept: string[] = []
    if (context.blockAt === undefined) return { clearing, kept }
    const { x: x0, y: y0, z: z0 } = context.origin
    for (let i = 0; i < p.width; i += 1)
      for (let j = 0; j < p.length; j += 1)
        for (const up of [1, 2]) {
          const at = { x: x0 + i, y: y0 + up, z: z0 + j }
          const found = context.blockAt(at)
          if (found === undefined || isOpenAir(found) || isReplaceable(found)) continue
          if (isClearable(found, false)) clearing.push({ kind: 'break', at, branch: 'interior' })
          else kept.push(found)
        }
    return { clearing, kept }
  }
}
