import type { AreaGuard } from '../../core/area-guard.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { GroveSpot, FarmRegistry } from '../../state/farm-registry.js'
import type { Bounds } from './farm-area.types.js'
import {
  isLeavesName,
  isLogName,
  isPassThrough,
  isPlantableGround,
  isSaplingName,
  isTreeAvoidedNeighbour,
  type TreeSpec,
} from './tree-table.js'

/** How far above and below the given rectangle the surface is looked for. */
const SURFACE_MARGIN = 4
const NEIGHBOUR_RADIUS = 2
const MAX_CELLS = 3000
const EXISTING_SEARCH = 128

export interface GroveRegion {
  /** Where trees may stand (x/z), and the ground level to look around (y). */
  readonly rect: Bounds
  /** A part of the rectangle to leave clear, for example the house a ring goes around. */
  readonly keepOut?: Bounds | undefined
}

export interface SpotRequest {
  readonly tree: TreeSpec
  readonly big: boolean
  readonly count: number
  readonly region: GroveRegion
  readonly spacing: number
  /** The grove being planted into, so its own footprint and protection are not counted against it. */
  readonly own?: { readonly id: string; readonly label: string } | undefined
}

export interface SpotResult {
  readonly spots: readonly GroveSpot[]
  /** How many spots the region could hold at this spacing. */
  readonly capacity: number
  /** Why cells were turned down, with how many. */
  readonly rejected: Readonly<Record<string, number>>
}

export interface GroveSpotDeps {
  readonly blocks: BlockScanner
  readonly guard: AreaGuard
  readonly farms: FarmRegistry
}

const cellKey = (x: number, z: number): string => `${String(x)},${String(z)}`

/**
 * Works out where saplings can go: on dirt-type ground with the free space above the species needs, spread out by
 * its spacing, away from other farms, protected areas, doors, paths, and existing trees. Pure reading of the world:
 * nothing is placed.
 */
export class GroveSpotFinder {
  constructor(private readonly deps: GroveSpotDeps) {}

  find(request: SpotRequest): SpotResult | { readonly error: string } {
    const { rect, keepOut } = request.region
    const size = request.big ? 2 : 1
    const xMin = Math.min(rect.from.x, rect.to.x)
    const xMax = Math.max(rect.from.x, rect.to.x)
    const zMin = Math.min(rect.from.z, rect.to.z)
    const zMax = Math.max(rect.from.z, rect.to.z)
    if ((xMax - xMin + 1) * (zMax - zMin + 1) > MAX_CELLS)
      return { error: `That area is larger than ${String(MAX_CELLS)} blocks; use a smaller one.` }

    const yTop = Math.max(rect.from.y, rect.to.y) + SURFACE_MARGIN
    const yBottom = Math.min(rect.from.y, rect.to.y) - SURFACE_MARGIN
    const clearance = request.big ? request.tree.bigClearance : request.tree.clearance
    const others = this.deps.farms.all().filter((farm) => farm.id !== request.own?.id)
    const taken = this.existingTrees(xMin, zMin, xMax, zMax, request.spacing)
    const rejected = new Map<string, number>()
    const reject = (reason: string): void => {
      rejected.set(reason, (rejected.get(reason) ?? 0) + 1)
    }

    const valid: GroveSpot[] = []
    for (let x = xMin; x <= xMax - (size - 1); x += 1) {
      for (let z = zMin; z <= zMax - (size - 1); z += 1) {
        if (this.tooClose(x, z, taken, valid, request.spacing)) continue
        if (keepOut !== undefined && this.overlaps(x, z, size, keepOut)) {
          reject('keep_out')
          continue
        }
        if (others.some((farm) => this.overlaps(x, z, size, farm.bounds, 1))) {
          reject('near_other_farm')
          continue
        }
        const site = this.site(x, z, size, yTop, yBottom, clearance, request.own?.label)
        if (typeof site === 'string') {
          reject(site)
          continue
        }
        valid.push({ x, y: site, z, size })
      }
    }
    return {
      spots: spread(valid, request.count),
      capacity: valid.length,
      rejected: Object.fromEntries(rejected),
    }
  }

  private overlaps(x: number, z: number, size: number, box: Bounds, margin = 0): boolean {
    const boxXMin = Math.min(box.from.x, box.to.x) - margin
    const boxXMax = Math.max(box.from.x, box.to.x) + margin
    const boxZMin = Math.min(box.from.z, box.to.z) - margin
    const boxZMax = Math.max(box.from.z, box.to.z) + margin
    return x + size - 1 >= boxXMin && x <= boxXMax && z + size - 1 >= boxZMin && z <= boxZMax
  }

  private tooClose(
    x: number,
    z: number,
    taken: readonly { readonly x: number; readonly z: number }[],
    chosen: readonly GroveSpot[],
    spacing: number,
  ): boolean {
    const near = (other: { readonly x: number; readonly z: number }): boolean =>
      Math.max(Math.abs(other.x - x), Math.abs(other.z - z)) < spacing
    return taken.some(near) || chosen.some(near)
  }

  /** The sapling cell's y for a footprint that can hold a tree, or the reason it cannot. */
  private site(
    x: number,
    z: number,
    size: number,
    yTop: number,
    yBottom: number,
    clearance: number,
    ownLabel: string | undefined,
  ): number | string {
    let groundY: number | undefined
    for (let dx = 0; dx < size; dx += 1) {
      for (let dz = 0; dz < size; dz += 1) {
        const ground = this.groundAt(x + dx, z + dz, yTop, yBottom)
        if (typeof ground === 'string') return ground
        if (groundY !== undefined && ground !== groundY) return 'uneven_ground'
        groundY = ground
      }
    }
    if (groundY === undefined) return 'no_ground'
    for (let dx = 0; dx < size; dx += 1) {
      for (let dz = 0; dz < size; dz += 1) {
        const guarded = this.deps.guard.protectedAt({ x: x + dx, y: groundY + 1, z: z + dz })
        if (guarded !== undefined && guarded.label !== ownLabel) return 'protected'
        for (let dy = 1; dy <= clearance; dy += 1) {
          const name = this.deps.blocks.blockAt({ x: x + dx, y: groundY + dy, z: z + dz })
          if (name === undefined) return 'unloaded'
          if (isPassThrough(name)) continue
          if (dy > 1 && isLeavesName(name)) continue
          return 'blocked_above'
        }
      }
    }
    for (let dx = -NEIGHBOUR_RADIUS; dx < size + NEIGHBOUR_RADIUS; dx += 1) {
      for (let dz = -NEIGHBOUR_RADIUS; dz < size + NEIGHBOUR_RADIUS; dz += 1) {
        for (const y of [groundY, groundY + 1]) {
          const name = this.deps.blocks.blockAt({ x: x + dx, y, z: z + dz })
          if (name !== undefined && isTreeAvoidedNeighbour(name)) return 'near_path_or_door'
        }
      }
    }
    return groundY + 1
  }

  /** The y of the dirt-type ground under the open sky of a column, or why there is none. */
  private groundAt(x: number, z: number, yTop: number, yBottom: number): number | string {
    for (let y = yTop; y >= yBottom; y -= 1) {
      const name = this.deps.blocks.blockAt({ x, y, z })
      if (name === undefined) return 'unloaded'
      if (isPassThrough(name) || isLeavesName(name)) continue
      return isPlantableGround(name) ? y : 'not_plantable_ground'
    }
    return 'no_ground'
  }

  /** Saplings and grown trees already standing in and around the area, so new ones keep their distance. */
  private existingTrees(
    xMin: number,
    zMin: number,
    xMax: number,
    zMax: number,
    spacing: number,
  ): readonly { readonly x: number; readonly z: number }[] {
    const known = this.deps.blocks.knownBlockNames()
    const names = known.filter((name) => isSaplingName(name) || isLogName(name))
    if (names.length === 0) return []
    const found = this.deps.blocks.findBlocks({ names, maxDistance: EXISTING_SEARCH, count: 400 })
    const seen = new Map<string, { x: number; z: number }>()
    for (const block of found) {
      const { x, y, z } = block.position
      if (x < xMin - spacing || x > xMax + spacing || z < zMin - spacing || z > zMax + spacing) continue
      if (!isSaplingName(block.name)) {
        const below = this.deps.blocks.blockAt({ x, y: y - 1, z })
        if (below === undefined || !isPlantableGround(below)) continue
      }
      seen.set(cellKey(x, z), { x, z })
    }
    return [...seen.values()]
  }
}

/** `count` of the spots, evenly spread through the list (all of them when there are no more than `count`). */
function spread(spots: readonly GroveSpot[], count: number): readonly GroveSpot[] {
  if (spots.length <= count) return spots
  const chosen: GroveSpot[] = []
  for (let i = 0; i < count; i += 1) {
    const spot = spots[Math.floor((i * spots.length) / count)]
    if (spot !== undefined) chosen.push(spot)
  }
  return chosen
}
