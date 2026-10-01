import type { BlockScanner } from '../../../core/block-scanner.port.js'
import type { Position } from '../../../core/position.types.js'

const OPEN = new Set([
  'air',
  'cave_air',
  'torch',
  'wall_torch',
  'rail',
  'powered_rail',
  'detector_rail',
  'activator_rail',
  'ladder',
])
/** Floors that hurt or give way. */
const BAD_FLOORS = new Set([
  'magma_block',
  'campfire',
  'soul_campfire',
  'cactus',
  'powder_snow',
  'sweet_berry_bush',
])
/** What a natural cave roof is made of (a house or a tree is not a cave). */
const NATURAL_ROOF =
  /^(stone|deepslate|dirt|grass_block|coarse_dirt|podzol|mycelium|andesite|diorite|granite|tuff|calcite|gravel|sand|red_sand|sandstone|red_sandstone|clay|dripstone_block|moss_block|netherrack|basalt|blackstone|smooth_basalt|.*_terracotta|terracotta|.*_ore)$/

/** Longest fall the bot may plan for; a longer one costs health (it matches the pathfinder's own limit). */
export const MAX_DROP = 3

export interface ReachedCell {
  readonly position: Position
  /** Walking steps from where the search began. */
  readonly steps: number
}

const key = (x: number, y: number, z: number): string => `${String(x)},${String(y)},${String(z)}`
const floor = (p: Position): Position => ({
  x: Math.floor(p.x),
  y: Math.floor(p.y),
  z: Math.floor(p.z),
})

const MOVES = [
  { dx: 1, dz: 0 },
  { dx: -1, dz: 0 },
  { dx: 0, dz: 1 },
  { dx: 0, dz: -1 },
]

/** Reads the loaded blocks around the bot as walkable space: where it can stand, and how it can get from cell to cell. */
export class CaveMap {
  constructor(private readonly blocks: BlockScanner) {}

  private open(x: number, y: number, z: number): boolean {
    const name = this.blocks.blockAt({ x, y, z })
    return name !== undefined && OPEN.has(name)
  }

  /** Lava close by (or water at the feet) makes a cell one to keep away from. */
  private dangerNear(x: number, y: number, z: number): boolean {
    for (let dx = -1; dx <= 1; dx += 1)
      for (let dz = -1; dz <= 1; dz += 1)
        for (let dy = -1; dy <= 2; dy += 1) {
          const name = this.blocks.blockAt({ x: x + dx, y: y + dy, z: z + dz })
          if (name === 'lava') return true
        }
    return this.blocks.blockAt({ x, y, z }) === 'water'
  }

  /** Room to stand: open feet and head, a solid floor that does not hurt, and no lava near. */
  standable(at: Position): boolean {
    const { x, y, z } = floor(at)
    if (!this.open(x, y, z) || !this.open(x, y + 1, z)) return false
    const below = this.blocks.blockAt({ x, y: y - 1, z })
    if (
      below === undefined ||
      BAD_FLOORS.has(below) ||
      this.blocks.isSolid({ x, y: y - 1, z }) !== true
    )
      return false
    return !this.dangerNear(x, y, z)
  }

  /** Every cell the bot can walk to from `from` within `radius` blocks, nearest first (only cells `admit` allows, when given). Drops longer than 3 are not used. */
  reach(
    from: Position,
    radius: number,
    maxCells = 4000,
    admit?: (cell: Position) => boolean,
  ): { cells: ReachedCell[]; truncated: boolean } {
    const start = floor(from)
    const seen = new Set<string>([key(start.x, start.y, start.z)])
    const cells: ReachedCell[] = []
    let frontier = [start]
    let steps = 0
    while (frontier.length > 0) {
      const next: Position[] = []
      for (const cell of frontier) {
        cells.push({ position: cell, steps })
        if (cells.length >= maxCells) return { cells, truncated: true }
        for (const { dx, dz } of MOVES) {
          const x = cell.x + dx
          const z = cell.z + dz
          if (Math.max(Math.abs(x - start.x), Math.abs(z - start.z)) > radius) continue
          for (const dy of [1, 0, -1, -2, -3]) {
            const y = cell.y + dy
            if (Math.abs(y - start.y) > radius || seen.has(key(x, y, z))) continue
            if (!this.canStep(cell, x, y, z, dy)) continue
            if (admit !== undefined && !admit({ x, y, z })) continue
            seen.add(key(x, y, z))
            next.push({ x, y, z })
            break
          }
        }
      }
      frontier = next
      steps += 1
    }
    return { cells, truncated: false }
  }

  private canStep(from: Position, x: number, y: number, z: number, dy: number): boolean {
    if (!this.standable({ x, y, z })) return false
    if (dy === 1) return this.open(from.x, from.y + 2, from.z) // room to jump up
    // Walking off an edge: the column beside must be open all the way down.
    for (let level = y + 1; level <= from.y + 1; level += 1)
      if (!this.open(x, level, z)) return false
    return true
  }

  /** A solid block of natural stone or earth above within `height`: the cell is under a cave roof. */
  roofed(at: Position, height = 8): boolean {
    const { x, y, z } = floor(at)
    for (let level = y + 2; level <= y + 1 + height; level += 1) {
      const name = this.blocks.blockAt({ x, y: level, z })
      if (name === undefined) return false
      if (OPEN.has(name) || name === 'water' || name === 'lava' || name.endsWith('_leaves'))
        continue
      return NATURAL_ROOF.test(name)
    }
    return false
  }

  /** Under open sky, as far as the loaded blocks show: nothing solid up to the top of the loaded column. */
  skyAbove(at: Position, height = 64): boolean {
    const { x, y, z } = floor(at)
    for (let level = y + 2; level <= y + 1 + height; level += 1) {
      const name = this.blocks.blockAt({ x, y: level, z })
      if (name === undefined) return true
      if (OPEN.has(name) || name === 'water') continue
      if (name.endsWith('_leaves')) continue
      return false
    }
    return true
  }

  /** The nearest walkable cell under a natural roof, reached from `from`: the mouth of a cave. */
  findMouth(from: Position, radius: number): Position | undefined {
    // The open ground around is walked first, so the limit must allow for all of it.
    for (const { position } of this.reach(from, radius, 12_000).cells)
      if (this.roofed(position, 6)) return position
    return undefined
  }

  /** The ground falls away by 8 blocks or more within reach: the top of a ravine or a pit. */
  dropsAway(from: Position, radius: number): boolean {
    const top = Math.floor(from.y)
    return this.reach(from, radius).cells.some(({ position }) => position.y <= top - 8)
  }

  /**
   * A ravine is a deep cut open to the sky; anything else with a roof is a cave. Judged from the walkable cells:
   * mostly open to the sky and at least 8 blocks between the highest and the lowest.
   */
  classify(cells: readonly ReachedCell[]): 'cave' | 'ravine' {
    if (cells.length === 0) return 'cave'
    let sky = 0
    let low = Infinity
    let high = -Infinity
    for (const { position } of cells) {
      if (this.skyAbove(position)) sky += 1
      low = Math.min(low, position.y)
      high = Math.max(high, position.y)
    }
    return sky * 2 >= cells.length && high - low >= 8 ? 'ravine' : 'cave'
  }
}

const NEIGHBOUR_OFFSETS = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
]

/** The keys of the cells a `reach` found, for quick lookups. */
export const reachedKeys = (cells: readonly ReachedCell[]): Set<string> =>
  new Set(cells.map(({ position }) => key(position.x, position.y, position.z)))

/**
 * Whether the bot can stand next to a block: one of the cells beside it (or the cell below one, since a block in a wall
 * is reached from the floor) is a place it can walk to. A block in a sealed pocket has no such cell.
 */
export function canStandBeside(block: Position, reached: ReadonlySet<string>): boolean {
  for (const offset of NEIGHBOUR_OFFSETS) {
    const x = block.x + offset.x
    const y = block.y + offset.y
    const z = block.z + offset.z
    if (reached.has(key(x, y, z)) || reached.has(key(x, y - 1, z))) return true
  }
  return false
}
