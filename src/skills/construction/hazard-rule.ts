import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Position } from '../../core/position.types.js'
import { cellKey } from './standing-spot.js'
import type { WorkPlan, WorkStep } from './work-plan.types.js'

/** Why a dig stopped where it did. */
export type HazardReason =
  | 'hit_lava'
  | 'hit_water'
  | 'cave_breakthrough'
  | 'falling_blocks'
  | 'spawner'
  | 'player_block'
  | 'unloaded'

export interface Hazard {
  readonly reason: HazardReason
  /** The cell that stopped the dig (the fluid, the cavity, the spawner, ...). */
  readonly at: Position
}

const NEIGHBOURS: readonly Position[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
]
const OPEN = new Set(['air', 'cave_air', 'void_air'])
/** Blocks that fall when what holds them is gone. */
const FALLING = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel'])
/** Things a player made or a dungeon holds: never broken by a dig, and the dig ends there. */
const LEFT_ALONE = new Set([
  'chest',
  'trapped_chest',
  'ender_chest',
  'barrel',
  'furnace',
  'blast_furnace',
  'smoker',
  'crafting_table',
  'rail',
  'powered_rail',
  'detector_rail',
  'activator_rail',
  'end_portal_frame',
  'end_portal',
  'nether_portal',
])

const isFalling = (name: string | undefined): boolean =>
  name !== undefined && (FALLING.has(name) || name.endsWith('_concrete_powder'))

/**
 * The rule that keeps a dig from flooding, falling, or wandering into something it must not touch. Before a block is
 * broken it looks at that block and at the six blocks that touch it: **lava or water in any of them ends the dig
 * there** (breaking the block would let the fluid flow in). It also ends on an open cavity in the way (a cave
 * breakthrough), on sand or gravel that would fall into the opening, on a spawner, on chests, rails, and other things
 * people make, and on a block that is not loaded.
 */
export class HazardRule {
  constructor(private readonly blocks: BlockScanner) {}

  /** The hazard at a break step, or undefined when it is safe to break. `cells` are all cells the plan works on. */
  check(
    step: Extract<WorkStep, { kind: 'break' }>,
    plan: WorkPlan,
    cells: ReadonlySet<string>,
  ): Hazard | undefined {
    const at = step.at
    const here = this.blocks.blockAt(at)
    if (here === undefined) return { reason: 'unloaded', at }
    if (here === 'spawner') return { reason: 'spawner', at }
    if (LEFT_ALONE.has(here)) return { reason: 'player_block', at }

    for (const around of [{ x: 0, y: 0, z: 0 }, ...NEIGHBOURS]) {
      const cell = { x: at.x + around.x, y: at.y + around.y, z: at.z + around.z }
      const name = this.blocks.blockAt(cell)
      if (name === 'lava') return { reason: 'hit_lava', at: cell }
      if (name === 'water') return { reason: 'hit_water', at: cell }
    }

    const above = { x: at.x, y: at.y + 1, z: at.z }
    if (isFalling(this.blocks.blockAt(above)) && !cells.has(cellKey(above)))
      return { reason: 'falling_blocks', at: above }

    if (plan.cavityCheck === true) {
      for (const offset of step.probe ?? []) {
        const cell = { x: at.x + offset.x, y: at.y + offset.y, z: at.z + offset.z }
        if (cells.has(cellKey(cell))) continue // part of the dig itself
        const name = this.blocks.blockAt(cell)
        if (name !== undefined && OPEN.has(name)) return { reason: 'cave_breakthrough', at: cell }
      }
    }
    return undefined
  }
}
