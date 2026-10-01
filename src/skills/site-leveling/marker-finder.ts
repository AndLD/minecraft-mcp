import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Position } from '../../core/position.types.js'

export const DEFAULT_MARKER_BLOCKS: readonly string[] = ['dirt', 'cobblestone']
const HORIZONTAL: readonly Position[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
]

const key = (p: Position): string => `${String(p.x)},${String(p.z)}`
const up = (p: Position, n = 1): Position => ({ x: p.x, y: p.y + n, z: p.z })

export interface MarkerBase {
  readonly position: Position
  readonly distance: number
}

export type MarkerResult =
  | {
      readonly ok: true
      readonly a: Position
      readonly b: Position
      readonly extra: readonly Position[]
    }
  | { readonly ok: false; readonly found: readonly Position[] }

/**
 * Finds the two vertical, two-block-high stacks of a marker block a player placed to mark a plot's opposite
 * corners: on solid ground, with air above and on all four sides at both heights, so ordinary terrain (a slope, a
 * wall) is never mistaken for a marker.
 */
export class MarkerFinder {
  constructor(private readonly blocks: BlockScanner) {}

  find(
    center: Position,
    options: { readonly markerBlocks?: readonly string[]; readonly radius?: number } = {},
  ): MarkerResult {
    const names = options.markerBlocks ?? DEFAULT_MARKER_BLOCKS
    const radius = options.radius ?? 64
    // Generous on purpose: dirt and cobblestone are also ordinary terrain, so a world with much of either nearby
    // (a dirt-heavy underground, a cobblestone cave) needs many more than a handful of nearest matches before an
    // actual isolated marker stack, several blocks off in some other direction, is even among the candidates.
    const candidates = this.blocks.findBlocks({ names, maxDistance: radius, count: 400 })

    const seen = new Set<string>()
    const bases: MarkerBase[] = []
    for (const candidate of candidates) {
      const columnKey = key(candidate.position)
      if (seen.has(columnKey)) continue
      if (!this.isStackBase(candidate.position, candidate.name)) continue
      seen.add(columnKey)
      bases.push({ position: candidate.position, distance: candidate.distance })
    }

    if (bases.length < 2) return { ok: false, found: bases.map((b) => b.position) }
    bases.sort((a, b) => a.distance - b.distance)
    const [a, b, ...rest] = bases as [MarkerBase, MarkerBase, ...MarkerBase[]]
    return { ok: true, a: a.position, b: b.position, extra: rest.map((r) => r.position) }
  }

  /** Whether `position` is the foot of a valid two-high marker stack of `name`. */
  private isStackBase(position: Position, name: string): boolean {
    const { blocks } = this
    if (blocks.blockAt(position) !== name || blocks.blockAt(up(position)) !== name) return false
    if (blocks.blockAt({ x: position.x, y: position.y - 1, z: position.z }) === name) return false // not the top block
    if (blocks.isSolid({ x: position.x, y: position.y - 1, z: position.z }) !== true) return false
    if (blocks.isSolid(up(position, 2)) === true) return false
    for (const offset of HORIZONTAL) {
      for (const level of [0, 1]) {
        const cell = up(
          { x: position.x + offset.x, y: position.y, z: position.z + offset.z },
          level,
        )
        if (blocks.isSolid(cell) === true) return false
      }
    }
    return true
  }
}
