import { z } from 'zod'
import type { Position } from '../../../core/position.types.js'
import type { WorkPlan, WorkStep } from '../../construction/work-plan.types.js'
import type { FarmLayoutContext, FarmLayoutProvider } from '../farm-layout.types.js'

const MAX_HIVES = 8
/** Columns between two hives: room for the bees to come and go, and for the bot to walk between them. */
const SPACING = 3

const apiaryParams = z.object({
  hives: z
    .number()
    .int()
    .min(1)
    .max(MAX_HIVES)
    .default(3)
    .describe(`How many beehives (1 to ${String(MAX_HIVES)}).`),
  flower: z
    .string()
    .min(1)
    .default('poppy')
    .describe(
      'The flower planted in a row beside the hives (an item name such as poppy or dandelion); it needs grass or dirt below.',
    ),
  campfire: z
    .boolean()
    .default(true)
    .describe(
      'Put a campfire under each hive, so harvesting is always smoked. Without it each hive sits on a fence post.',
    ),
})

type ApiaryParams = z.output<typeof apiaryParams>

/**
 * A row of beehives with a row of flowers beside them. Bees need flowers within about 22 blocks and adopt an empty hive
 * within about 20, so a stocked apiary fills itself; `lure_animals` and `breed_animals` (with flowers) do the rest.
 * The hive sits directly on its campfire (smoke reaches up to 5 blocks below a hive, in the same column), so a harvest
 * with `harvest_honey` is always smoked. The hives and the campfires are placed by the plan; the flowers are best
 * effort.
 */
export class ApiaryProvider implements FarmLayoutProvider<ApiaryParams> {
  readonly kind = 'apiary'
  readonly description =
    'A row of beehives along x (three blocks apart) with a row of flowers beside them, starting at the lowest x/z ' +
    'corner (by default the ground block two blocks east of the bot): `hives`, `flower`, and `campfire` (a campfire ' +
    'under each hive, default true, so honey is always harvested with smoke). Needs a beehive per hive (6 planks and ' +
    '3 honeycomb; the bot does not craft one from honeycomb it would have to take from a hive), a campfire each, and ' +
    'flowers. Empty hives attract wild bees within about 20 blocks.'
  readonly params = apiaryParams

  defaultOrigin(feet: Position): Position {
    return { x: Math.floor(feet.x) + 2, y: Math.floor(feet.y) - 1, z: Math.floor(feet.z) }
  }

  speciesOf(): string {
    return 'bee'
  }

  generate(p: ApiaryParams, context: FarmLayoutContext): WorkPlan | { error: string } {
    const { x: x0, y: y0, z: z0 } = context.origin
    const steps: WorkStep[] = []
    for (let i = 0; i < p.hives; i += 1) {
      const x = x0 + i * SPACING
      if (p.campfire) {
        steps.push({
          kind: 'place',
          at: { x, y: y0 + 1, z: z0 },
          block: 'campfire',
          branch: `hive${String(i)}`,
        })
        steps.push({
          kind: 'place',
          at: { x, y: y0 + 2, z: z0 },
          block: 'beehive',
          branch: `hive${String(i)}`,
        })
      } else {
        steps.push({
          kind: 'place',
          at: { x, y: y0 + 1, z: z0 },
          block: 'oak_fence',
          branch: `hive${String(i)}`,
        })
        steps.push({
          kind: 'place',
          at: { x, y: y0 + 2, z: z0 },
          block: 'beehive',
          branch: `hive${String(i)}`,
        })
      }
    }
    const width = (p.hives - 1) * SPACING + 1
    for (let i = 0; i < width; i += 1)
      steps.push({
        kind: 'place',
        at: { x: x0 + i, y: y0 + 1, z: z0 + 2 },
        block: p.flower,
        optional: true,
        passable: true,
        branch: 'flowers',
      })
    return { name: `apiary of ${String(p.hives)} hives`, steps, standing: 'outside' }
  }
}
