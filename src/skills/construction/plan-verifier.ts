import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Position } from '../../core/position.types.js'
import { isOpenAir } from './block-match.js'
import { isSpecialBlock } from './special-blocks.js'
import { cellKey } from './standing-spot.js'
import type { WorkPlan, WorkStep } from './work-plan.types.js'

export interface Scan {
  /** How many of the plan's dig cells were looked at. */
  readonly checked: number
  /** Dig cells holding a block that is not part of the plan and not special: to be cleared. */
  readonly strays: readonly Position[]
  /** Dig cells holding a special block (a chest, a torch, a door...) that is left where it is. */
  readonly kept: number
  /** Dig cells holding water or lava: reported, never cleared. */
  readonly fluids: readonly Position[]
}

/**
 * Reads a dug shape back from the world: which of its cells still hold a block they should not, and which open cells
 * beside it a sealed dig should have closed. Special blocks are never counted as strays.
 */
export class PlanVerifier {
  constructor(private readonly blocks: BlockScanner) {}

  scan(plan: WorkPlan, skip: (step: WorkStep) => boolean, planted: ReadonlySet<string>): Scan {
    const strays: Position[] = []
    const fluids: Position[] = []
    let checked = 0
    let kept = 0
    for (const step of plan.steps) {
      if (step.kind !== 'break' || skip(step)) continue
      const name = this.blocks.blockAt(step.at)
      if (name === undefined) continue
      checked += 1
      if (isOpenAir(name) || planted.has(name)) continue
      if (isSpecialBlock(name)) kept += 1
      else if (name === 'water' || name === 'lava') fluids.push(step.at)
      else strays.push(step.at)
    }
    return { checked, strays, kept, fluids }
  }

  /**
   * Open cells outside the dug volume that touch it where a cave should have been closed (the neighbours a step
   * probes), each once. The volume's own cells are never among them.
   */
  openings(plan: WorkPlan, skip: (step: WorkStep) => boolean): Position[] {
    const volume = new Set(plan.steps.filter((s) => s.kind === 'break').map((s) => cellKey(s.at)))
    const found = new Map<string, Position>()
    for (const step of plan.steps) {
      if (step.kind !== 'break' || skip(step)) continue
      for (const offset of step.probe ?? []) {
        const cell = { x: step.at.x + offset.x, y: step.at.y + offset.y, z: step.at.z + offset.z }
        const key = cellKey(cell)
        if (volume.has(key) || found.has(key)) continue
        if (isOpenAir(this.blocks.blockAt(cell))) found.set(key, cell)
      }
    }
    return [...found.values()]
  }
}
