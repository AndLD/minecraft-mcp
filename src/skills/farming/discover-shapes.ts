export interface Cell {
  readonly x: number
  readonly z: number
}

export interface Region {
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
  /** How many cells the region holds. */
  readonly cells: number
}

const keyOf = (x: number, z: number): string => `${String(x)},${String(z)}`

/**
 * Groups cells that lie within `gap` of each other on both axes (a gap of 2 bridges a one-block channel of water
 * between two halves of a field). Nearest-neighbour chaining, so a long thin field stays one group.
 */
export function clusterCells(cells: readonly Cell[], gap: number): Cell[][] {
  const known = new Map(cells.map((cell) => [keyOf(cell.x, cell.z), cell]))
  const seen = new Set<string>()
  const groups: Cell[][] = []
  for (const start of cells) {
    if (seen.has(keyOf(start.x, start.z))) continue
    const group: Cell[] = []
    const queue: Cell[] = [start]
    seen.add(keyOf(start.x, start.z))
    while (queue.length > 0) {
      const current = queue.pop()
      if (current === undefined) break
      group.push(current)
      for (let dx = -gap; dx <= gap; dx += 1) {
        for (let dz = -gap; dz <= gap; dz += 1) {
          const key = keyOf(current.x + dx, current.z + dz)
          const next = known.get(key)
          if (next === undefined || seen.has(key)) continue
          seen.add(key)
          queue.push(next)
        }
      }
    }
    groups.push(group)
  }
  return groups
}

export const boundsOfCells = (cells: readonly Cell[]): Omit<Region, 'cells'> => ({
  minX: Math.min(...cells.map((cell) => cell.x)),
  maxX: Math.max(...cells.map((cell) => cell.x)),
  minZ: Math.min(...cells.map((cell) => cell.z)),
  maxZ: Math.max(...cells.map((cell) => cell.z)),
})

const STEPS: readonly Cell[] = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 },
]

/**
 * The free areas fully closed in by the barrier cells (one level): floods the free space from outside the barriers'
 * bounding box, and whatever it cannot reach is enclosed. Free areas are separate regions, so two pens sharing a
 * fence are two enclosures. Cells only touching at a corner do not let the flood through.
 */
export function findEnclosures(barriers: readonly Cell[]): Region[] {
  if (barriers.length === 0) return []
  const wall = new Set(barriers.map((cell) => keyOf(cell.x, cell.z)))
  const box = boundsOfCells(barriers)
  const inside = (x: number, z: number): boolean =>
    x >= box.minX - 1 && x <= box.maxX + 1 && z >= box.minZ - 1 && z <= box.maxZ + 1

  const outside = new Set<string>([keyOf(box.minX - 1, box.minZ - 1)])
  const queue: Cell[] = [{ x: box.minX - 1, z: box.minZ - 1 }]
  while (queue.length > 0) {
    const current = queue.pop()
    if (current === undefined) break
    for (const step of STEPS) {
      const x = current.x + step.x
      const z = current.z + step.z
      const key = keyOf(x, z)
      if (!inside(x, z) || wall.has(key) || outside.has(key)) continue
      outside.add(key)
      queue.push({ x, z })
    }
  }

  const regions: Region[] = []
  const claimed = new Set<string>()
  for (let x = box.minX; x <= box.maxX; x += 1) {
    for (let z = box.minZ; z <= box.maxZ; z += 1) {
      const key = keyOf(x, z)
      if (wall.has(key) || outside.has(key) || claimed.has(key)) continue
      const cells: Cell[] = []
      const pending: Cell[] = [{ x, z }]
      claimed.add(key)
      while (pending.length > 0) {
        const current = pending.pop()
        if (current === undefined) break
        cells.push(current)
        for (const step of STEPS) {
          const nx = current.x + step.x
          const nz = current.z + step.z
          const nkey = keyOf(nx, nz)
          if (wall.has(nkey) || outside.has(nkey) || claimed.has(nkey)) continue
          claimed.add(nkey)
          pending.push({ x: nx, z: nz })
        }
      }
      regions.push({ ...boundsOfCells(cells), cells: cells.length })
    }
  }
  return regions
}
