import type { WorkStep } from '../construction/work-plan.types.js'

/** How many fence posts apart a torch goes, so a fenced area is lit against mob spawns without one on every post. */
export const TORCH_SPACING = 5

export const GATE_SIDES = ['north', 'south', 'east', 'west'] as const
/** Which side of the ring the gate is in. */
export type GateSide = (typeof GATE_SIDES)[number]

/** The parameter description shared by every layout that builds a fence ring (a field, a pen). */
export const GATE_SIDE_DESCRIPTION =
  'Which side of the fence the gate is in, at the middle of that side: north (low z), south (high z, default), east (high x), or west (low x).'

export interface FenceRingOptions {
  /** The footprint's lowest x/z corner. */
  readonly x0: number
  /** Ground level; the fence sits at `y0 + 1`. */
  readonly y0: number
  readonly z0: number
  readonly width: number
  readonly length: number
  readonly torches: boolean
  /** The side the gate is in, at the middle of it (default south). */
  readonly gateSide?: GateSide
}

/**
 * The axis the bot stands on, in line with the gate, when it places it. A gate faces the way the bot looks, and its
 * panel lies across that direction, so it fits into a fence that runs along x (a north or south side) only when the
 * bot looks along z, and into one that runs along z (an east or west side) only when it looks along x. This is the same
 * rule the door of a house follows.
 */
export const gateAlignAxis = (side: GateSide): 'x' | 'z' =>
  side === 'north' || side === 'south' ? 'z' : 'x'

/**
 * A fence ring one cell outside a `width` by `length` footprint, one gate in the middle of one side (south unless
 * asked), torches along the way every `TORCH_SPACING` posts. Shared by `CropFieldProvider` and `AnimalPenProvider`.
 */
export function fenceRingSteps(o: FenceRingOptions): WorkStep[] {
  const side = o.gateSide ?? 'south'
  const west = o.x0 - 1
  const east = o.x0 + o.width
  const north = o.z0 - 1
  const south = o.z0 + o.length
  const middleX = o.x0 + Math.floor((o.width - 1) / 2)
  const middleZ = o.z0 + Math.floor((o.length - 1) / 2)
  const gate = {
    north: { x: middleX, z: north },
    south: { x: middleX, z: south },
    east: { x: east, z: middleZ },
    west: { x: west, z: middleZ },
  }[side]
  const perimeter: { readonly x: number; readonly z: number; readonly gate: boolean }[] = []
  const add = (x: number, z: number): void => {
    perimeter.push({ x, z, gate: x === gate.x && z === gate.z })
  }
  for (let x = west; x <= east; x += 1) add(x, north)
  for (let z = north + 1; z <= south; z += 1) add(east, z)
  for (let x = east - 1; x >= west; x -= 1) add(x, south)
  for (let z = south - 1; z > north; z -= 1) add(west, z)

  const steps: WorkStep[] = []
  let post = 0
  for (const cell of perimeter) {
    if (cell.gate) {
      steps.push({
        kind: 'place',
        at: { x: cell.x, y: o.y0 + 1, z: cell.z },
        block: 'oak_fence_gate',
        alignAxis: gateAlignAxis(side),
        branch: 'fence',
      })
      continue
    }
    steps.push({
      kind: 'place',
      at: { x: cell.x, y: o.y0 + 1, z: cell.z },
      block: 'oak_fence',
      branch: 'fence',
    })
    if (o.torches && post % TORCH_SPACING === 0)
      steps.push({
        kind: 'light',
        at: { x: cell.x, y: o.y0 + 2, z: cell.z },
        minLight: 8,
        spacing: TORCH_SPACING,
        branch: 'fence',
      })
    post += 1
  }
  return steps
}
