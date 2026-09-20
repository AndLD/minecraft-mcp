import { z } from 'zod'
import type { Position } from '../../../core/position.types.js'
import type { WorkPlan, WorkStep } from '../../construction/work-plan.types.js'
import type { ExcavationContext, ExcavationProvider } from '../excavation.types.js'
import { feetCell, probeAllBut, side } from './geometry.js'

const MAX_DEPTH = 256

interface DigDown {
  readonly name: string
  readonly x0: number
  readonly y0: number
  readonly z0: number
  readonly width: number
  readonly length: number
  /** Layers to dig, the first at y0 and each next one below. */
  readonly depth: number
  /** Ladders up the west wall, so the bot can climb out. */
  readonly ladder: boolean
  /** Check for cave breakthroughs too (a shaft), not only fluids. */
  readonly cavities: boolean
}

/**
 * Digs a rectangle straight down, layer by layer from the top. Each column is its own chain, so a hazard (lava or
 * water beside a cell, a cave) ends only that column. With ladders, one is placed in the west-wall column right after
 * each layer is dug, so there is always a way back up.
 */
export function digDown(spec: DigDown): WorkPlan {
  const steps: WorkStep[] = []
  const ladderZ = spec.z0 + Math.floor(spec.length / 2)
  const probe = spec.cavities ? probeAllBut({ x: 0, y: 1, z: 0 }) : undefined
  for (let layer = 0; layer < spec.depth; layer += 1) {
    const y = spec.y0 - layer
    for (let i = 0; i < spec.width; i += 1) {
      // Snake along z, so the bot does not walk back after every row.
      for (let n = 0; n < spec.length; n += 1) {
        const j = i % 2 === 0 ? n : spec.length - 1 - n
        steps.push({
          kind: 'break',
          at: { x: spec.x0 + i, y, z: spec.z0 + j },
          branch: `column-${String(i)}-${String(j)}`,
          ...(probe === undefined ? {} : { probe }),
        })
      }
    }
    if (spec.ladder)
      steps.push({
        kind: 'place',
        at: { x: spec.x0, y, z: ladderZ },
        block: 'ladder',
        against: { x: -1, y: 0, z: 0 },
      })
  }
  return {
    name: spec.name,
    steps,
    standing: 'inside',
    hazards: 'end_branch',
    cavityCheck: spec.cavities,
    veins: { maxSize: 64 },
  }
}

const exitParam = z
  .enum(['ladder', 'none'])
  .default('ladder')
  .describe(
    '"ladder" (default): a ladder goes up the west wall as the layers are dug, so the bot can climb out (needs one ladder per layer). "none": no way out is built.',
  )

/** Default: the ground block two blocks east of the bot, so the first layer is the one the bot stands on. */
const surfaceOrigin = (feet: Position): Position => {
  const cell = feetCell(feet)
  return { x: cell.x + 2, y: cell.y - 1, z: cell.z }
}

const pitParams = z.object({
  width: side('Size along the x axis (east-west)'),
  length: side('Size along the z axis (north-south)'),
  depth: z
    .number()
    .int()
    .min(1)
    .max(MAX_DEPTH)
    .describe(`How many layers deep (1 to ${String(MAX_DEPTH)}).`),
  exit: exitParam,
})

export class PitProvider implements ExcavationProvider<z.output<typeof pitParams>> {
  readonly name = 'pit'
  readonly description =
    'A rectangular pit: `width` (x) by `length` (z) by `depth` layers, dug from the top layer down. The origin is the ' +
    'lowest x and z corner of the TOP layer (by default the ground block two blocks east of the bot, so the first layer is ' +
    'at the height the bot stands on). Ladders up the west wall let the bot climb out.'
  readonly params = pitParams

  defaultOrigin(feet: Position): Position {
    return surfaceOrigin(feet)
  }

  generate(p: z.output<typeof pitParams>, context: ExcavationContext): WorkPlan {
    const { x, y, z: z0 } = context.origin
    return digDown({
      name: `pit ${String(p.width)}x${String(p.length)}x${String(p.depth)}`,
      x0: x,
      y0: y,
      z0,
      width: p.width,
      length: p.length,
      depth: p.depth,
      ladder: p.exit === 'ladder' && p.depth > 1,
      cavities: false,
    })
  }
}

const shaftParams = z.object({
  depth: z
    .number()
    .int()
    .min(1)
    .max(MAX_DEPTH)
    .describe(`How many layers deep (1 to ${String(MAX_DEPTH)}).`),
  width: side('Size along x').default(1),
  length: side('Size along z').default(1),
  exit: exitParam,
})

export class ShaftProvider implements ExcavationProvider<z.output<typeof shaftParams>> {
  readonly name = 'shaft'
  readonly description =
    'A vertical shaft, one block by one by default (`width`, `length` for a wider one), dug straight down `depth` layers. ' +
    'Like a pit, but every cell is also checked for an open cavity (a cave) in the way, and the dig of that column ends ' +
    'there. The origin is the top cell (by default the ground block two blocks east of the bot). Ladders let the bot climb out.'
  readonly params = shaftParams

  defaultOrigin(feet: Position): Position {
    return surfaceOrigin(feet)
  }

  generate(p: z.output<typeof shaftParams>, context: ExcavationContext): WorkPlan {
    const { x, y, z: z0 } = context.origin
    return digDown({
      name: `shaft ${String(p.width)}x${String(p.length)}x${String(p.depth)}`,
      x0: x,
      y0: y,
      z0,
      width: p.width,
      length: p.length,
      depth: p.depth,
      ladder: p.exit === 'ladder' && p.depth > 1,
      cavities: true,
    })
  }
}

const quarryParams = z
  .object({
    width: side('Size along the x axis (east-west)'),
    length: side('Size along the z axis (north-south)'),
    to_y: z
      .number()
      .int()
      .optional()
      .describe('Dig down to this height (the last layer dug is at this y).'),
    above_bedrock: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Dig down to this many layers above the lowest layer of the world (-64 in the overworld, so 9 means y = -55; 0 in the Nether and the End). This is the default target, with 9, when neither this nor to_y is given.',
      ),
    exit: exitParam,
  })
  .refine((p) => p.to_y === undefined || p.above_bedrock === undefined, {
    message: 'Give either to_y or above_bedrock, not both.',
  })

export class QuarryProvider implements ExcavationProvider<z.output<typeof quarryParams>> {
  readonly name = 'quarry'
  readonly description =
    'A rectangular quarry: `width` by `length`, dug layer by layer from the top down to a target level, given as `to_y` ' +
    'or as `above_bedrock` (levels above the lowest layer; the default target is 9 above it, y = -55 in the overworld). ' +
    'The origin is the lowest x and z corner of the TOP layer (by default the ground block two blocks east of the bot). ' +
    'Ladders up the west wall (one per layer) let the bot climb out. Ores that touch the dug space are mined too. A ' +
    'big quarry is thousands of blocks: preview it first, and mind the inventory (the storage policy decides what happens when it fills).'
  readonly params = quarryParams

  defaultOrigin(feet: Position): Position {
    return surfaceOrigin(feet)
  }

  generate(
    p: z.output<typeof quarryParams>,
    context: ExcavationContext,
  ): WorkPlan | { error: string } {
    const bottom = p.to_y ?? context.minY + (p.above_bedrock ?? 9)
    const depth = context.origin.y - bottom + 1
    if (bottom < context.minY + 1)
      return {
        error: `The target level y = ${String(bottom)} is at or below the bedrock (the lowest layer is ${String(context.minY)}).`,
      }
    if (depth < 1)
      return {
        error: `The target level y = ${String(bottom)} is above where the dig starts (y = ${String(context.origin.y)}).`,
      }
    if (depth > MAX_DEPTH)
      return { error: `That is ${String(depth)} layers deep; the limit is ${String(MAX_DEPTH)}.` }
    const { x, y, z: z0 } = context.origin
    return digDown({
      name: `quarry ${String(p.width)}x${String(p.length)} to y=${String(bottom)}`,
      x0: x,
      y0: y,
      z0,
      width: p.width,
      length: p.length,
      depth,
      ladder: p.exit === 'ladder' && depth > 1,
      cavities: false,
    })
  }
}
