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
  /** How the bot gets out: ladders up the west wall, a staircase cut around the outside, or nothing. */
  readonly exit: 'ladder' | 'stairs' | 'none'
  /** A 2×2×2 pit in the far corner of the bottom with water in it, to jump into from the top. */
  readonly waterLanding?: boolean
  /** Check for cave breakthroughs too (a shaft), not only fluids. */
  readonly cavities: boolean
  /** How many cells the `exit: 'stairs'` walkway is wide, radially outward from the footprint. Default 1. */
  readonly stairWidth?: number
  /** How many cells tall each `exit: 'stairs'` step is. Default 4. */
  readonly stairHeight?: number
}

/** A cell of the ring around a footprint, with the unit step back towards the footprint (used to widen the ring). */
export interface RingCell {
  readonly x: number
  readonly z: number
  readonly dx: number
  readonly dz: number
}

/**
 * The cells `margin` blocks outside a width × length footprint, clockwise from its north-west corner, each carrying
 * the unit step (`dx`, `dz`) back towards the footprint.
 */
export function ringAround(
  x0: number,
  z0: number,
  width: number,
  length: number,
  margin = 1,
): RingCell[] {
  const west = x0 - margin
  const east = x0 + width - 1 + margin
  const north = z0 - margin
  const south = z0 + length - 1 + margin
  const cells: RingCell[] = []
  for (let x = west; x <= east; x += 1) cells.push({ x, z: north, dx: 0, dz: 1 })
  for (let z = north + 1; z <= south; z += 1) cells.push({ x: east, z, dx: -1, dz: 0 })
  for (let x = east - 1; x >= west; x -= 1) cells.push({ x, z: south, dx: 0, dz: -1 })
  for (let z = south - 1; z >= north + 1; z -= 1) cells.push({ x: west, z, dx: 1, dz: 0 })
  return cells
}

/**
 * One step of the staircase that winds down around the outside of the footprint: a walkable slot `stairHeight` blocks
 * high, `stairWidth` cells wide (widening inward from the outer ring, towards the footprint), one block lower than the
 * step before, in the next cell of the ring. It opens into the pit beside it, so at every level the way up starts at
 * the level the bot works on. Each cell needs the one before it to be open; a widened cell needs the spine cell (the
 * single-wide column the original, unwidened staircase would have used) at the same height.
 */
function stairStep(
  y0: number,
  layer: number,
  ring: readonly RingCell[],
  stairWidth: number,
  stairHeight: number,
): WorkStep[] {
  const at = ring[layer % ring.length]
  const previous = ring[(layer - 1 + ring.length) % ring.length]
  if (at === undefined || previous === undefined) return []
  const foot = y0 - layer
  const steps: WorkStep[] = []
  for (let d = 0; d < stairWidth; d += 1) {
    const x = at.x + at.dx * d
    const z = at.z + at.dz * d
    for (let j = 0; j < stairHeight; j += 1) {
      const needs: Position | undefined =
        j > 0
          ? { x, y: foot + j - 1, z }
          : d > 0
            ? { x: at.x, y: foot, z: at.z }
            : layer > 0
              ? { x: previous.x, y: foot + 1, z: previous.z }
              : undefined
      steps.push({
        kind: 'break',
        at: { x, y: foot + j, z },
        branch: 'stairs',
        ...(needs === undefined ? {} : { needs }),
      })
    }
  }
  return steps
}

/** A 2×2 pit two blocks deep below the floor of the far (south-east) corner, with two water sources set diagonally. */
function waterLanding(spec: DigDown): WorkStep[] {
  const x = spec.x0 + spec.width - 2
  const z = spec.z0 + spec.length - 2
  const floor = spec.y0 - spec.depth + 1
  const steps: WorkStep[] = []
  for (const y of [floor - 1, floor - 2])
    for (const dx of [0, 1])
      for (const dz of [0, 1])
        steps.push({ kind: 'break', at: { x: x + dx, y, z: z + dz }, branch: 'landing' })
  // Two sources on the diagonal make the other two (water renews itself between them) and the water falls into the
  // lower layer: all eight cells fill, and the surface is one block below the quarry floor.
  for (const d of [0, 1])
    steps.push({
      kind: 'place',
      at: { x: x + d, y: floor - 1, z: z + d },
      block: 'water_bucket',
      branch: 'landing',
    })
  return steps
}

/**
 * Digs a rectangle straight down, layer by layer from the top. Each column is its own chain, so a hazard (lava or
 * water beside a cell, a cave) ends only that column. With ladders, one is placed in the west-wall column right after
 * each layer is dug, so there is always a way back up.
 */
export function digDown(spec: DigDown): WorkPlan {
  const steps: WorkStep[] = []
  const ladderZ = spec.z0 + Math.floor(spec.length / 2)
  const stairWidth = spec.stairWidth ?? 1
  const stairHeight = spec.stairHeight ?? 4
  // The ring is computed at the outer edge of the walkway (margin = stairWidth); stairStep widens inward from there.
  const ring =
    spec.exit === 'stairs' ? ringAround(spec.x0, spec.z0, spec.width, spec.length, stairWidth) : []
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
    if (spec.exit === 'stairs')
      steps.push(...stairStep(spec.y0, layer, ring, stairWidth, stairHeight))
    if (spec.exit === 'ladder')
      steps.push({
        kind: 'place',
        at: { x: spec.x0, y, z: ladderZ },
        block: 'ladder',
        against: { x: -1, y: 0, z: 0 },
        // The ladder belongs to its column: when a hazard ends the column, no ladder goes further down.
        branch: `column-0-${String(Math.floor(spec.length / 2))}`,
      })
  }
  if (spec.waterLanding === true) steps.push(...waterLanding(spec))
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
  .enum(['ladder', 'stairs', 'none'])
  .default('ladder')
  .describe(
    '"ladder" (default): a ladder goes up the west wall as the layers are dug (one ladder per layer). "stairs": a walkable staircase is cut around the outside of the footprint, one step down for every layer, opening into the pit at every level (no materials needed). "none": no way out is built.',
  )

/**
 * The stairs' own size, separate from the footprint (`width`/`length`): they are extra cells beyond its edge, never
 * counted into the dig's own dimensions.
 */
const stairSizeParams = {
  stair_width: z
    .number()
    .int()
    .min(1)
    .max(8)
    .default(1)
    .describe(
      'Only with exit: stairs. How many cells wide the staircase is, radially outward from the footprint (not lengthways: the same number of steps, just a wider, easier-to-walk band). Default 1, unchanged from a plain "stair walls" request. Not part of width or length.',
    ),
  stair_height: z
    .number()
    .int()
    .min(2)
    .max(8)
    .default(4)
    .describe('Only with exit: stairs. How many cells tall each step is. Default 4.'),
}

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
  ...stairSizeParams,
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
      exit: p.exit === 'ladder' && p.depth < 2 ? 'none' : p.exit,
      cavities: false,
      stairWidth: p.stair_width,
      stairHeight: p.stair_height,
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
  ...stairSizeParams,
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
      exit: p.exit === 'ladder' && p.depth < 2 ? 'none' : p.exit,
      cavities: true,
      stairWidth: p.stair_width,
      stairHeight: p.stair_height,
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
    water_landing: z
      .boolean()
      .default(false)
      .describe(
        'Off by default. When true: a 2×2×2 pit is dug in the far (south-east) corner below the quarry floor and filled with water from two water buckets, so you can jump in from the top and land unhurt (the exit ladder or stairs is on the other side). Needs 2 water_bucket and a footprint of at least 2×2.',
      ),
    ...stairSizeParams,
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
    if (p.water_landing && (p.width < 2 || p.length < 2))
      return { error: 'A water landing needs a footprint of at least 2 by 2.' }
    if (p.water_landing && bottom - 2 < context.minY + 1)
      return {
        error: 'There is no room for a water landing (two layers) above the bedrock at that depth.',
      }
    const { x, y, z: z0 } = context.origin
    return digDown({
      name: `quarry ${String(p.width)}x${String(p.length)} to y=${String(bottom)}`,
      x0: x,
      y0: y,
      z0,
      width: p.width,
      length: p.length,
      depth,
      exit: p.exit === 'ladder' && depth < 2 ? 'none' : p.exit,
      waterLanding: p.water_landing,
      cavities: false,
      stairWidth: p.stair_width,
      stairHeight: p.stair_height,
    })
  }
}
