import type { BlockScanner } from '../../../core/block-scanner.port.js'
import { countItems } from '../../../core/inventory-counts.js'
import type { InventoryReader } from '../../../core/inventory.port.js'
import type { Placer } from '../../../core/placer.port.js'
import type { Position } from '../../../core/position.types.js'
import type { SkillContext } from '../../../core/skill.types.js'
import type { SupplyCrafter } from '../../construction/crafting-supplies.js'
import type { SiteSafety } from '../../construction/site-safety.js'

const TORCH = 'torch'
/** Torches made at once when the last one is used. */
const TORCH_BATCH = 8

export type LightOutcome = 'lit' | 'placed' | 'no_torches' | 'failed'

export interface LightManagerDeps {
  readonly safety: SiteSafety
  readonly placer: Placer
  readonly blocks: BlockScanner
  readonly inventory: InventoryReader
  /** Crafts torches from coal or charcoal and sticks. */
  readonly supplies?: SupplyCrafter
}

/** Puts a torch down where the way is dark and no torch is near, on the right-hand side going in so the way out is lit. */
export class LightManager {
  constructor(private readonly deps: LightManagerDeps) {}

  torches(): number {
    return countItems(this.deps.inventory.snapshot()).get(TORCH) ?? 0
  }

  /** `heading` is the direction the bot walked to get here (one of the four axes), or none. */
  async ensure(
    standing: Position,
    heading: { dx: number; dz: number },
    limits: { minLight: number; spacing: number },
    context: SkillContext,
  ): Promise<LightOutcome> {
    const here = { x: Math.floor(standing.x), y: Math.floor(standing.y), z: Math.floor(standing.z) }
    if (!this.deps.safety.needsTorch(here, limits.minLight, limits.spacing)) return 'lit'
    if (this.torches() === 0) {
      await this.deps.supplies?.craft(TORCH, TORCH_BATCH, context)
      if (this.torches() === 0) return 'no_torches'
    }
    for (const cell of this.candidates(here, heading)) {
      const placed = await this.deps.placer.placeAt(TORCH, cell)
      if (placed.ok) return 'placed'
    }
    return 'failed'
  }

  /** Right of the way in, left, behind, and last the cell the bot stands in: an open cell with a floor. */
  private candidates(here: Position, heading: { dx: number; dz: number }): Position[] {
    const right = { dx: -heading.dz, dz: heading.dx }
    const offsets = [
      right,
      { dx: -right.dx, dz: -right.dz },
      { dx: -heading.dx, dz: -heading.dz },
      { dx: 0, dz: 0 },
    ]
    const cells: Position[] = []
    for (const { dx, dz } of offsets) {
      const cell = { x: here.x + dx, y: here.y, z: here.z + dz }
      const name = this.deps.blocks.blockAt(cell)
      const floorSolid = this.deps.blocks.isSolid({ x: cell.x, y: cell.y - 1, z: cell.z }) === true
      if ((name === 'air' || name === 'cave_air') && floorSolid) cells.push(cell)
    }
    return cells
  }
}
