import { z } from 'zod'
import type { Position } from '../../../core/position.types.js'
import type { WorkPlan, WorkStep } from '../../construction/work-plan.types.js'
import type { ExcavationContext, ExcavationProvider } from '../excavation.types.js'
import {
  add,
  directionParam,
  feetCell,
  HEADINGS,
  negate,
  probeAllBut,
  side,
  type Direction,
} from './geometry.js'

const MAX_LENGTH = 256
export const lightParams = {
  torch_spacing: z
    .number()
    .int()
    .min(0)
    .max(32)
    .default(6)
    .describe(
      'A torch about every this many blocks (default 6; 0 means no torches). The dig stops with no_torches when they run out.',
    ),
  min_light: z
    .number()
    .int()
    .min(1)
    .max(15)
    .default(7)
    .describe('Torches go where the light is below this (default 7).'),
}

/** Whether, and with what, a cave the dig finds is closed instead of left open. */
export const sealParams = {
  seal_caves: z
    .boolean()
    .default(true)
    .describe(
      'Seal a cave the dig meets with a placed block instead of leaving it open (default true): the tunnel stays fully enclosed, and a chain that met the cave carries on past it to its planned extent instead of stopping there for good. Set to false to break into a found cave on purpose and leave it open.',
    ),
  seal_block: z
    .string()
    .default('cobblestone')
    .describe(
      'The block placed to close a cave, falling back to dirt when none of it is carried. Only used when seal_caves is true.',
    ),
}

export const sealFor = (p: {
  readonly seal_caves: boolean
  readonly seal_block: string
}): { readonly block: string; readonly fallback: string } | undefined =>
  p.seal_caves ? { block: p.seal_block, fallback: 'dirt' } : undefined

const UP: Position = { x: 0, y: 1, z: 0 }

/** The tunnel's cells and lights: `length` sections of `width` x `height`, starting at the origin. */
function tunnelSteps(input: {
  origin: Position
  direction: Direction
  length: number
  width: number
  height: number
  torchSpacing: number
  minLight: number
  branch: string
}): WorkStep[] {
  const { forward, right } = HEADINGS[input.direction]
  const probe = probeAllBut(negate(forward))
  const steps: WorkStep[] = []
  const cell = (i: number, a: number, b: number): Position =>
    add(add(add(input.origin, forward, i), right, a), UP, b)
  // Every cell needs the one before it to be open: a cell that could only be reached through rock is not dug.
  const before = (i: number, a: number, b: number): Position | undefined =>
    b > 0 ? cell(i, a, b - 1) : a > 0 ? cell(i, a - 1, 0) : i > 0 ? cell(i - 1, 0, 0) : undefined
  for (let i = 0; i < input.length; i += 1) {
    for (let b = 0; b < input.height; b += 1)
      for (let a = 0; a < input.width; a += 1) {
        const needs = before(i, a, b)
        steps.push({
          kind: 'break',
          at: cell(i, a, b),
          branch: input.branch,
          probe,
          ...(needs === undefined ? {} : { needs }),
        })
      }
    if (input.torchSpacing > 0 && (i + 1) % input.torchSpacing === 0)
      steps.push({
        kind: 'light',
        at: cell(i, 0, 0),
        minLight: input.minLight,
        spacing: input.torchSpacing,
        required: true,
        branch: input.branch,
      })
  }
  return steps
}

const tunnelParams = z.object({
  direction: directionParam,
  length: z
    .number()
    .int()
    .min(1)
    .max(MAX_LENGTH)
    .describe(`How far to dig, in blocks (1 to ${String(MAX_LENGTH)}).`),
  width: side('Width across the tunnel').max(8).default(1),
  height: z
    .number()
    .int()
    .min(2)
    .max(8)
    .default(2)
    .describe('Height in blocks (2 to 8, default 2).'),
  ...lightParams,
  ...sealParams,
})

export class TunnelProvider implements ExcavationProvider<z.output<typeof tunnelParams>> {
  readonly name = 'tunnel'
  readonly description =
    'A straight tunnel: `length` blocks in a `direction`, `width` (default 1) by `height` (default 2) blocks in cross ' +
    "section. It starts where the bot stands (the origin is the first cross-section's lowest cell on the left, looking " +
    'along the direction). It has NO side branches; use branch_mine for those. Torches are placed about every ' +
    '`torch_spacing` blocks. The dig of the tunnel ends, with the reason and the place recorded, at lava or water (it ' +
    'stops one block short), an open cavity, sand or gravel overhead, a spawner, or a chest or rails; it never breaks those.'
  readonly params = tunnelParams

  defaultOrigin(feet: Position): Position {
    return feetCell(feet)
  }

  generate(p: z.output<typeof tunnelParams>, context: ExcavationContext): WorkPlan {
    return {
      name: `tunnel ${String(p.width)}x${String(p.height)}x${String(p.length)} ${p.direction}`,
      steps: tunnelSteps({
        origin: context.origin,
        direction: p.direction,
        length: p.length,
        width: p.width,
        height: p.height,
        torchSpacing: p.torch_spacing,
        minLight: p.min_light,
        branch: 'main',
      }),
      standing: 'inside',
      hazards: 'end_branch',
      cavityCheck: true,
      veins: { maxSize: 64 },
      seal: sealFor(p),
    }
  }
}

const branchMineParams = z.object({
  direction: directionParam,
  length: z
    .number()
    .int()
    .min(1)
    .max(MAX_LENGTH)
    .describe(`Length of the main tunnel (1 to ${String(MAX_LENGTH)}).`),
  spacing: z
    .number()
    .int()
    .min(2)
    .max(16)
    .default(3)
    .describe(
      'A side branch leaves the main tunnel every this many blocks (default 3: two blocks of rock between neighbouring branches).',
    ),
  branch_length: z
    .number()
    .int()
    .min(1)
    .max(64)
    .default(10)
    .describe('Length of each side branch (default 10).'),
  sides: z
    .enum(['both', 'left', 'right'])
    .default('both')
    .describe('Which sides get branches (default both).'),
  ...lightParams,
  ...sealParams,
})

export class BranchMineProvider implements ExcavationProvider<z.output<typeof branchMineParams>> {
  readonly name = 'branch_mine'
  readonly description =
    'A main tunnel (1 wide, 2 high) with side branches on both sides, perpendicular to it, one every `spacing` blocks ' +
    '(default 3) and each `branch_length` long: the pattern that shows ore on both sides and above and below every ' +
    'branch. Use it only when the player asks for branches or a mine; a plain tunnel has none. The main tunnel is dug ' +
    'first, then the branches from the entrance outwards; a hazard ends only the tunnel or branch that meets it (and ' +
    'branches beyond the end of a short main tunnel are skipped). Torches go along the main tunnel, along every branch, ' +
    'and at every junction. It starts where the bot stands.'
  readonly params = branchMineParams

  defaultOrigin(feet: Position): Position {
    return feetCell(feet)
  }

  generate(p: z.output<typeof branchMineParams>, context: ExcavationContext): WorkPlan {
    const { forward, right } = HEADINGS[p.direction]
    const origin = context.origin
    const steps = tunnelSteps({
      origin,
      direction: p.direction,
      length: p.length,
      width: 1,
      height: 2,
      torchSpacing: p.torch_spacing,
      minLight: p.min_light,
      branch: 'main',
    })
    const sides = p.sides === 'both' ? [1, -1] : p.sides === 'right' ? [1] : [-1]
    for (let i = p.spacing; i < p.length; i += p.spacing) {
      const junction = add(origin, forward, i)
      steps.push({
        kind: 'light',
        at: junction,
        minLight: p.min_light,
        spacing: 3,
        required: p.torch_spacing > 0,
        branch: 'main',
      })
      for (const s of sides) {
        const sideVector = { x: right.x * s, y: 0, z: right.z * s }
        const probe = probeAllBut(negate(sideVector))
        const branch = `${s > 0 ? 'right' : 'left'}-${String(i)}`
        for (let k = 1; k <= p.branch_length; k += 1) {
          for (let b = 0; b < 2; b += 1)
            steps.push({
              kind: 'break',
              at: add(add(junction, sideVector, k), UP, b),
              branch,
              // Each cell needs the one before it (the first: the junction on the main tunnel) to be open.
              needs: b === 1 ? add(junction, sideVector, k) : add(junction, sideVector, k - 1),
              probe,
            })
          if (p.torch_spacing > 0 && k % p.torch_spacing === 0)
            steps.push({
              kind: 'light',
              at: add(junction, sideVector, k),
              minLight: p.min_light,
              spacing: p.torch_spacing,
              required: true,
              branch,
            })
        }
      }
    }
    return {
      name: `branch mine ${String(p.length)} ${p.direction}, branches every ${String(p.spacing)}`,
      steps,
      standing: 'inside',
      hazards: 'end_branch',
      cavityCheck: true,
      veins: { maxSize: 64 },
      seal: sealFor(p),
    }
  }
}

/** The default target when neither `depth`, `to_y`, nor `above_bedrock` is given: the same as `quarry`. */
const DEFAULT_STAIR_ABOVE_BEDROCK = 9

const stairParams = z
  .object({
    direction: directionParam,
    depth: z
      .number()
      .int()
      .min(1)
      .max(MAX_LENGTH)
      .optional()
      .describe(
        `An exact number of steps down instead of a target level (each step goes one block forward and one down; ` +
          `1 to ${String(MAX_LENGTH)}). Give this or a target level (to_y/above_bedrock), not both; with none of the ` +
          `three, the default target is above_bedrock: ${String(DEFAULT_STAIR_ABOVE_BEDROCK)}.`,
      ),
    to_y: z
      .number()
      .int()
      .optional()
      .describe(
        'Go down to this height (the last step is at this y). Give this or above_bedrock, not both.',
      ),
    above_bedrock: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Go down to this many layers above the lowest layer of the world (-64 in the overworld, so 9 means y = -55; ' +
          `0 in the Nether and the End). This is the default target, with ${String(DEFAULT_STAIR_ABOVE_BEDROCK)}, when ` +
          'none of this, to_y, or depth is given.',
      ),
    stair_width: z
      .number()
      .int()
      .min(1)
      .max(8)
      .default(2)
      .describe(
        'How many cells wide the staircase is, across the direction of travel (default 2: room for the bot and a ' +
          'following player side by side). Every step is dug this wide, not only the exit.',
      ),
    stair_height: z
      .number()
      .int()
      .min(2)
      .max(8)
      .default(4)
      .describe('How many cells tall the headroom is at each step (default 4).'),
    ...lightParams,
    ...sealParams,
  })
  .refine((p) => p.to_y === undefined || p.above_bedrock === undefined, {
    message: 'Give either to_y or above_bedrock, not both.',
  })
  .refine((p) => p.depth === undefined || (p.to_y === undefined && p.above_bedrock === undefined), {
    message: 'Give either depth or a target level (to_y/above_bedrock), not both.',
  })

interface StairTarget {
  readonly depth: number
  /** How the target appears in the plan's name: "N down" for an explicit depth, "to y=N" for a target level. */
  readonly label: string
}

/** Turns `depth`, `to_y`, or `above_bedrock` into a step count and a name label, or why it cannot be dug. */
function resolveStairTarget(
  p: { readonly depth?: number; readonly to_y?: number; readonly above_bedrock?: number },
  context: ExcavationContext,
): StairTarget | { readonly error: string } {
  if (p.depth !== undefined) return { depth: p.depth, label: `${String(p.depth)} down` }
  const bottom = p.to_y ?? context.minY + (p.above_bedrock ?? DEFAULT_STAIR_ABOVE_BEDROCK)
  if (bottom < context.minY + 1)
    return {
      error: `The target level y = ${String(bottom)} is at or below the bedrock (the lowest layer is ${String(context.minY)}).`,
    }
  const depth = context.origin.y - bottom + 1
  if (depth < 1)
    return {
      error: `The target level y = ${String(bottom)} is above where the dig starts (y = ${String(context.origin.y)}).`,
    }
  return { depth, label: `to y=${String(bottom)}` }
}

export class StaircaseDownProvider implements ExcavationProvider<z.output<typeof stairParams>> {
  readonly name = 'staircase_down'
  readonly description =
    'A staircase descending in a `direction`, `stair_width` (default 2) cells wide and `stair_height` (default 4) cells ' +
    'tall so the bot (and a following player) can walk it two abreast. Depth is a target level, `to_y` or `above_bedrock` ' +
    '(default 9 above the bedrock, the same as quarry), or an exact `depth` in steps instead. It starts where the bot ' +
    "stands (the first step is the bot's own cell). Use it to go underground or to reach the bottom of a pit on foot. " +
    'Torches are placed about every `torch_spacing` steps.'
  readonly params = stairParams

  defaultOrigin(feet: Position): Position {
    return feetCell(feet)
  }

  generate(
    p: z.output<typeof stairParams>,
    context: ExcavationContext,
  ): WorkPlan | { error: string } {
    const target = resolveStairTarget(p, context)
    if ('error' in target) return target
    if (target.depth > MAX_LENGTH)
      return {
        error: `That is ${String(target.depth)} steps deep; the limit is ${String(MAX_LENGTH)}.`,
      }

    const { forward, right } = HEADINGS[p.direction]
    // Not upwards: near the entrance the ceiling is the open sky, which is no cave.
    const probe = probeAllBut(negate(forward), UP)
    const seal = sealFor(p)
    const steps: WorkStep[] = []
    const footAt = (i: number): Position => add(add(context.origin, forward, i), UP, -i)
    for (let i = 0; i < target.depth; i += 1) {
      const foot = footAt(i)
      for (let a = 0; a < p.stair_width; a += 1) {
        const base = add(foot, right, a)
        // The tread (one below the step) is never dug or built by this plan and is assumed solid; seal it when a
        // cave may have hollowed it out, so every cell of the step has something underfoot.
        if (seal !== undefined)
          steps.push({ kind: 'seal', at: add(base, UP, -1), block: seal.block, branch: 'stairs' })
        for (let b = 0; b < p.stair_height; b += 1) {
          // Vertically, a cell needs the one below it; at the tread, a cell needs its neighbour towards the spine
          // (so the step is dug from the centre outward, never from a distance), and the spine cell of the first
          // step of a step needs the spine cell of the step before it.
          const needs: Position | undefined =
            b > 0
              ? add(base, UP, b - 1)
              : a > 0
                ? add(foot, right, a - 1)
                : i > 0
                  ? footAt(i - 1)
                  : undefined
          steps.push({
            kind: 'break',
            at: add(base, UP, b),
            branch: 'stairs',
            probe,
            ...(needs === undefined ? {} : { needs }),
          })
        }
      }
      if (p.torch_spacing > 0 && (i + 1) % p.torch_spacing === 0)
        steps.push({
          kind: 'light',
          at: foot,
          minLight: p.min_light,
          spacing: p.torch_spacing,
          required: true,
          branch: 'stairs',
        })
    }
    return {
      name: `staircase ${target.label} ${p.direction}`,
      steps,
      standing: 'inside',
      hazards: 'end_branch',
      cavityCheck: true,
      veins: { maxSize: 64 },
      seal,
    }
  }
}
