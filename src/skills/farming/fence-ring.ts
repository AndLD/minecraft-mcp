import type { WorkStep } from '../construction/work-plan.types.js'

/** How many fence posts apart a torch goes, so a fenced area is lit against mob spawns without one on every post. */
export const TORCH_SPACING = 5

export interface FenceRingOptions {
  /** The footprint's lowest x/z corner. */
  readonly x0: number
  /** Ground level; the fence sits at `y0 + 1`. */
  readonly y0: number
  readonly z0: number
  readonly width: number
  readonly length: number
  readonly torches: boolean
}

/**
 * A fence ring one cell outside a `width` by `length` footprint, one gate in the middle of the south side, torches
 * along the way every `TORCH_SPACING` posts. Shared by `CropFieldProvider` and `AnimalPenProvider`.
 */
export function fenceRingSteps(o: FenceRingOptions): WorkStep[] {
  const west = o.x0 - 1
  const east = o.x0 + o.width
  const north = o.z0 - 1
  const south = o.z0 + o.length
  const gateX = o.x0 + Math.floor((o.width - 1) / 2)
  const perimeter: { readonly x: number; readonly z: number; readonly gate: boolean }[] = []
  for (let x = west; x <= east; x += 1) perimeter.push({ x, z: north, gate: false })
  for (let z = north + 1; z <= south; z += 1) perimeter.push({ x: east, z, gate: false })
  for (let x = east - 1; x >= west; x -= 1) perimeter.push({ x, z: south, gate: x === gateX })
  for (let z = south - 1; z > north; z -= 1) perimeter.push({ x: west, z, gate: false })

  const steps: WorkStep[] = []
  let post = 0
  for (const cell of perimeter) {
    if (cell.gate) {
      steps.push({
        kind: 'place',
        at: { x: cell.x, y: o.y0 + 1, z: cell.z },
        block: 'oak_fence_gate',
        alignAxis: 'x',
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
