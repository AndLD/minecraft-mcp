import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { LightReader } from '../../core/light-reader.port.js'
import type { Position } from '../../core/position.types.js'
import type { WorkPlan } from './work-plan.types.js'

/** No two torches closer than this many blocks, so lighting does not use a torch per cell. */
export const TORCH_SPACING = 4
const TORCHES = ['torch', 'wall_torch']

/** Shared checks for every plan: hazards in and around the site, and lighting. */
export class SiteSafety {
  constructor(
    private readonly blocks: BlockScanner,
    private readonly light: LightReader,
  ) {}

  /** What makes the site unsafe, in words: lava in or right next to the volume the plan works in. */
  hazards(plan: WorkPlan): string[] {
    if (plan.steps.length === 0) return []
    const low = { x: Infinity, y: Infinity, z: Infinity }
    const high = { x: -Infinity, y: -Infinity, z: -Infinity }
    for (const { at } of plan.steps) {
      low.x = Math.min(low.x, at.x)
      low.y = Math.min(low.y, at.y)
      low.z = Math.min(low.z, at.z)
      high.x = Math.max(high.x, at.x)
      high.y = Math.max(high.y, at.y)
      high.z = Math.max(high.z, at.z)
    }
    let lava = 0
    for (let x = low.x - 1; x <= high.x + 1; x += 1)
      for (let y = low.y - 1; y <= high.y + 1; y += 1)
        for (let z = low.z - 1; z <= high.z + 1; z += 1)
          if (this.blocks.blockAt({ x, y, z }) === 'lava') lava += 1
    return lava === 0 ? [] : [`${String(lava)} lava block(s) in or next to the building site`]
  }

  /** Whether a torch belongs in the cell: it is darker than `minLight` and no torch stands within the spacing. */
  needsTorch(at: Position, minLight: number, spacing: number = TORCH_SPACING): boolean {
    const level = this.light.blockLightAt(at)
    if (level === undefined || level >= minLight) return false
    for (let dx = -spacing; dx <= spacing; dx += 1)
      for (let dy = -2; dy <= 2; dy += 1)
        for (let dz = -spacing; dz <= spacing; dz += 1) {
          const name = this.blocks.blockAt({ x: at.x + dx, y: at.y + dy, z: at.z + dz })
          if (name !== undefined && TORCHES.includes(name)) return false
        }
    return true
  }
}
