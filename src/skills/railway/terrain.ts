import type { AreaGuard } from '../../core/area-guard.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import { isOpenAir } from '../construction/block-match.js'
import { isNaturalTerrain, isTreePart, isVegetation } from '../site-leveling/natural-terrain.js'

export type ColumnKind = 'land' | 'water' | 'lava' | 'structure' | 'protected' | 'unloaded'

export interface Column {
  readonly kind: ColumnKind
  /** The ground block's y (land, structure), or the top water block's y (water). */
  readonly y: number
}

/** What a scan looks through on the way down to the ground: air, plants, snow, and a tree's own wood and leaves. */
export const isPassThrough = (name: string): boolean =>
  isOpenAir(name) || isVegetation(name) || isTreePart(name) || name === 'snow'

/**
 * The surface of each column of the world in a height range: natural ground, water (its top block), lava, a
 * player-made block, a protected area, or terrain that is not loaded. Answers are remembered, since a route search
 * asks for the same column many times.
 */
export class TerrainReader {
  private readonly known = new Map<string, Column>()

  constructor(
    private readonly blocks: BlockScanner,
    private readonly guard: AreaGuard,
    private readonly range: { readonly top: number; readonly bottom: number },
  ) {}

  column(x: number, z: number): Column {
    const key = `${String(x)},${String(z)}`
    const cached = this.known.get(key)
    if (cached !== undefined) return cached
    const found = this.scan(x, z)
    this.known.set(key, found)
    return found
  }

  private scan(x: number, z: number): Column {
    for (let y = this.range.top; y >= this.range.bottom; y -= 1) {
      const name = this.blocks.blockAt({ x, y, z })
      if (name === undefined) return { kind: 'unloaded', y }
      if (isPassThrough(name)) continue
      if (name === 'water') return { kind: 'water', y }
      if (name === 'lava') return { kind: 'lava', y }
      if (this.guard.protectedAt({ x, y: y + 1, z }) !== undefined) return { kind: 'protected', y }
      return { kind: isNaturalTerrain(name) ? 'land' : 'structure', y }
    }
    return { kind: 'unloaded', y: this.range.bottom }
  }
}
