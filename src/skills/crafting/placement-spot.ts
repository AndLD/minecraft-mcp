import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Position } from '../../core/position.types.js'

const OPEN_AIR = new Set(['air', 'cave_air'])
const RADIUS = 2

/** Finds a free cell near the bot to put a workstation (crafting table, furnace) in. */
export class PlacementSpotFinder {
  constructor(private readonly blocks: BlockScanner) {}

  /** A cell at the bot's level with headroom and a solid block below, closest first. Never the bot's own cell. */
  find(origin: Position): Position | undefined {
    const baseX = Math.floor(origin.x)
    const baseY = Math.floor(origin.y)
    const baseZ = Math.floor(origin.z)
    const spots: { position: Position; distance: number }[] = []
    for (let dx = -RADIUS; dx <= RADIUS; dx += 1) {
      for (let dz = -RADIUS; dz <= RADIUS; dz += 1) {
        if (dx === 0 && dz === 0) continue
        const position = { x: baseX + dx, y: baseY, z: baseZ + dz }
        if (this.isFree(position)) spots.push({ position, distance: Math.hypot(dx, dz) })
      }
    }
    return spots.sort((a, b) => a.distance - b.distance)[0]?.position
  }

  private isFree(position: Position): boolean {
    return (
      OPEN_AIR.has(this.blocks.blockAt(position) ?? '') &&
      OPEN_AIR.has(this.blocks.blockAt({ ...position, y: position.y + 1 }) ?? '') &&
      this.blocks.isSolid({ ...position, y: position.y - 1 }) === true
    )
  }
}
