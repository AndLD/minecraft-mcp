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
const lightParams = {
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
    }
  }
}

const stairParams = z.object({
  direction: directionParam,
  depth: z
    .number()
    .int()
    .min(1)
    .max(MAX_LENGTH)
    .describe(
      `How many steps down (each step goes one block forward and one down; 1 to ${String(MAX_LENGTH)}).`,
    ),
  ...lightParams,
})

export class StaircaseDownProvider implements ExcavationProvider<z.output<typeof stairParams>> {
  readonly name = 'staircase_down'
  readonly description =
    'A staircase descending in a `direction`: `depth` steps, each one block forward and one down, one block wide and ' +
    "three high so the bot can walk it. It starts where the bot stands (the first step is the bot's own cell). Use it to " +
    'go underground or to reach the bottom of a pit on foot. Torches are placed about every `torch_spacing` steps.'
  readonly params = stairParams

  defaultOrigin(feet: Position): Position {
    return feetCell(feet)
  }

  generate(p: z.output<typeof stairParams>, context: ExcavationContext): WorkPlan {
    const { forward } = HEADINGS[p.direction]
    const probe = probeAllBut(negate(forward))
    const steps: WorkStep[] = []
    for (let i = 0; i < p.depth; i += 1) {
      const foot = add(add(context.origin, forward, i), UP, -i)
      const previousFoot = add(add(context.origin, forward, i - 1), UP, -(i - 1))
      for (let b = 0; b < 3; b += 1)
        steps.push({
          kind: 'break',
          at: add(foot, UP, b),
          branch: 'stairs',
          probe,
          ...(b > 0 ? { needs: add(foot, UP, b - 1) } : i > 0 ? { needs: previousFoot } : {}),
        })
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
      name: `staircase ${String(p.depth)} down ${p.direction}`,
      steps,
      standing: 'inside',
      hazards: 'end_branch',
      cavityCheck: true,
      veins: { maxSize: 64 },
    }
  }
}
