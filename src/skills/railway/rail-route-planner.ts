import type { AreaGuard } from '../../core/area-guard.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Position } from '../../core/position.types.js'
import { err, ok, type Result } from '../../core/result.js'
import { isOpenAir, isReplaceable } from '../construction/block-match.js'
import { isNaturalTerrain, isTreePart, isVegetation } from '../site-leveling/natural-terrain.js'
import { searchPath, type Col } from './path-search.js'
import { isCorner } from './rail-orientation.js'
import { isRailName } from './rail-table.js'
import { TerrainReader } from './terrain.js'

export type Layout = 'surface' | 'underground' | 'auto'

/** A line is planned only up to this many rails; a longer one is built in stages. */
export const MAX_LENGTH = 400
const TURN_COST = 4
const SLOPE_COST = 0.4
const WATER_COLUMN_COST = 2.5
const CUT_COST = 1
const LOG_CUT_COST = 1.5
const DECK_COST = 1
const FALLING_OVERHEAD_COST = 4
const SURFACE_RANGE_BELOW = 6
const SURFACE_RANGE_ABOVE = 6
const HEIGHT_REACH = 40
const MAX_EXPANSIONS = 60_000
const MAX_RETRIES = 12
const DEFAULT_DEPTH = 6
const SNAP_REACH = 3
/** `auto` keeps to the surface while it takes no more than this much earthwork (cuts and decks) per rail. */
const AUTO_EARTHWORK_PER_RAIL = 1.5
const FALLING = new Set(['sand', 'red_sand', 'gravel'])

export interface RouteRequest {
  /** The rail cell the line starts at (where a person would stand). */
  readonly start: Position
  /** The rail cell it ends at. */
  readonly end: Position
  readonly layout: Layout
  /** For a tunnel: how far below the surface it runs in the middle (the ends come up to the surface). */
  readonly depth: number | undefined
}

export interface RailRoute {
  /** The rail cells, start to end: each next to the last, at most one block up or down. */
  readonly cells: readonly Position[]
  readonly layout: 'surface' | 'underground'
  /** Blocks that have to be broken, and support blocks that have to be placed, for this profile. */
  readonly cuts: number
  readonly decks: number
  /** The search's own measure of effort; comparable between the profiles of one request. */
  readonly cost: number
  /** Blocks of ground above each rail (0 in the open): a tunnel is lit where this is above 0. */
  readonly cover: readonly number[]
}

export interface RouteFailure {
  readonly reason: string
  readonly message: string
  readonly at?: Position
}

export interface RouteDeps {
  readonly blocks: BlockScanner
  readonly guard: AreaGuard
}

interface CellReading {
  readonly cost: number
  readonly cuts: number
  readonly decks: number
}

const LATERAL: readonly Col[] = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 },
]

/**
 * Plans where a railway runs. First the horizontal path between the two ends (a search over ground columns that
 * prefers straight runs and flat, natural, dry ground and keeps out of lava, other people's builds, and protected
 * areas), then how high each rail sits (a search over levels with at most one block up or down per rail, corners and
 * the rails next to them flat), choosing between cutting through a rise, bridging a dip, and following the ground.
 * When a column turns out to be impassable at every level, the horizontal path is searched again without it.
 */
export class RailRoutePlanner {
  constructor(private readonly deps: RouteDeps) {}

  /**
   * The rail cell for a place the player names: the block above the ground of that column when the given height is
   * within a few blocks of it (so "the ground I am looking at" and "where I stand" mean the same), otherwise as given.
   */
  snap(position: Position): Position {
    const terrain = new TerrainReader(this.deps.blocks, this.deps.guard, {
      top: position.y + SNAP_REACH,
      bottom: position.y - SNAP_REACH,
    })
    const column = terrain.column(position.x, position.z)
    if (column.kind === 'unloaded' || column.kind === 'lava') return position
    return { x: position.x, y: column.y + 1, z: position.z }
  }

  plan(request: RouteRequest): Result<RailRoute, RouteFailure> {
    if (request.layout === 'surface') return this.route(request, 'surface')
    if (request.layout === 'underground') return this.route(request, 'underground')

    const surface = this.route(request, 'surface')
    if (surface.ok) {
      const work = surface.value.cuts + surface.value.decks
      if (work <= AUTO_EARTHWORK_PER_RAIL * surface.value.cells.length) return surface
    }
    const tunnel = this.route(request, 'underground')
    if (tunnel.ok) return tunnel
    return surface.ok ? surface : tunnel
  }

  private route(
    request: RouteRequest,
    layout: 'surface' | 'underground',
  ): Result<RailRoute, RouteFailure> {
    const { start, end } = request
    const distance = Math.abs(start.x - end.x) + Math.abs(start.z - end.z)
    if (distance + 1 > MAX_LENGTH)
      return err({
        reason: 'too_long',
        message: `That is ${String(distance + 1)} rails; a line is planned up to ${String(MAX_LENGTH)}. Build it in stages.`,
      })
    if (distance === 0 && start.y === end.y)
      return err({ reason: 'same_place', message: 'The start and the end are the same place.' })

    const depth = request.depth ?? DEFAULT_DEPTH
    const top = Math.max(start.y, end.y) + HEIGHT_REACH
    const bottom = Math.min(start.y, end.y) - HEIGHT_REACH
    const terrain = new TerrainReader(this.deps.blocks, this.deps.guard, { top, bottom })
    const margin = Math.max(16, Math.ceil(distance / 4))
    const bounds = {
      minX: Math.min(start.x, end.x) - margin,
      maxX: Math.max(start.x, end.x) + margin,
      minZ: Math.min(start.z, end.z) - margin,
      maxZ: Math.max(start.z, end.z) + margin,
    }

    for (const which of [start, end]) {
      const column = terrain.column(which.x, which.z)
      if (column.kind === 'unloaded')
        return err({
          reason: 'unloaded',
          message: `The terrain at ${describe(which)} is not loaded. The bot only sees what is near it: plan from where it is, or build in stages.`,
          at: which,
        })
      if (column.kind === 'lava')
        return err({ reason: 'lava', message: `There is lava at ${describe(which)}.`, at: which })
      if (column.kind === 'protected')
        return err({
          reason: 'protected_area',
          message: `${describe(which)} is inside a protected area.`,
          at: which,
        })
    }

    const blocked = new Set<string>()
    let lastFailure: RouteFailure = { reason: 'no_route', message: 'No route was found.' }
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const path = searchPath({
        start,
        end,
        bounds,
        maxExpansions: MAX_EXPANSIONS,
        step: (from, to, turned) =>
          this.stepCost(terrain, blocked, start, end, from, to, turned, layout),
      })
      if (path === undefined) {
        const unloaded = this.firstUnloaded(terrain, bounds)
        return err(
          unloaded === undefined
            ? {
                ...lastFailure,
                reason: 'no_route',
                message: `${lastFailure.message} No way around was found.`.trim(),
              }
            : {
                reason: 'unloaded',
                message: `The terrain around ${describe({ x: unloaded.x, y: start.y, z: unloaded.z })} is not loaded, so no route could be found. Build in stages.`,
              },
        )
      }
      if (path.length > MAX_LENGTH)
        return err({
          reason: 'too_long',
          message: `The route needs ${String(path.length)} rails; a line is planned up to ${String(MAX_LENGTH)}. Build it in stages.`,
        })
      const profile = this.profile(path, terrain, start, end, layout, depth)
      if (profile.ok) return profile
      lastFailure = profile.error
      const index =
        profile.error.at === undefined ? undefined : this.indexOf(path, profile.error.at)
      const culprit = index === undefined ? undefined : path[index]
      if (culprit === undefined) return profile
      if (
        (culprit.x === start.x && culprit.z === start.z) ||
        (culprit.x === end.x && culprit.z === end.z)
      )
        return profile
      blocked.add(`${String(culprit.x)},${String(culprit.z)}`)
    }
    return err(lastFailure)
  }

  private indexOf(path: readonly Col[], at: Position): number | undefined {
    const index = path.findIndex((col) => col.x === at.x && col.z === at.z)
    return index === -1 ? undefined : index
  }

  private firstUnloaded(
    terrain: TerrainReader,
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  ): Col | undefined {
    for (let x = bounds.minX; x <= bounds.maxX; x += 4)
      for (let z = bounds.minZ; z <= bounds.maxZ; z += 4)
        if (terrain.column(x, z).kind === 'unloaded') return { x, z }
    return undefined
  }

  private stepCost(
    terrain: TerrainReader,
    blocked: ReadonlySet<string>,
    start: Col,
    end: Col,
    from: Col,
    to: Col,
    turned: boolean,
    layout: 'surface' | 'underground',
  ): number | undefined {
    const isEnd = (col: Col): boolean =>
      (col.x === start.x && col.z === start.z) || (col.x === end.x && col.z === end.z)
    if (!isEnd(to) && blocked.has(`${String(to.x)},${String(to.z)}`)) return undefined
    const next = terrain.column(to.x, to.z)
    if (next.kind === 'lava' || next.kind === 'unloaded') return undefined
    if (!isEnd(to) && (next.kind === 'structure' || next.kind === 'protected')) return undefined
    // A tunnel goes through a hill rather than around it: only the surface line cares how the ground rises.
    if (layout === 'underground') {
      return 1 + (turned ? TURN_COST : 0) + (next.kind === 'water' ? WATER_COLUMN_COST / 5 : 0)
    }
    const here = terrain.column(from.x, from.z)
    const rise = Math.abs(next.y - here.y)
    return (
      1 +
      (turned ? TURN_COST : 0) +
      SLOPE_COST * rise +
      2 * Math.max(0, rise - 1) +
      (next.kind === 'water' ? WATER_COLUMN_COST : 0)
    )
  }

  /** How high each rail of the path sits, or why no level works at some column. */
  private profile(
    path: readonly Col[],
    terrain: TerrainReader,
    start: Position,
    end: Position,
    layout: 'surface' | 'underground',
    depth: number,
  ): Result<RailRoute, RouteFailure> {
    const n = path.length
    const flat = path.map((col) => ({ x: col.x, y: 0, z: col.z }))
    const heights = path.map((col) => terrain.column(col.x, col.z).y)
    const forcedFirst = start.y - 1
    const forcedLast = end.y - 1
    const low = layout === 'underground' ? -(depth + SURFACE_RANGE_BELOW) : -SURFACE_RANGE_BELOW
    const lo = Math.min(...heights, forcedFirst, forcedLast) + low
    const hi = Math.max(...heights, forcedFirst, forcedLast) + SURFACE_RANGE_ABOVE
    const levels = hi - lo + 1

    const cover = (i: number): number =>
      layout === 'underground' ? Math.min(depth, i, n - 1 - i) : 0
    // A tunnel stays below the ground it passes under; on the surface a line may sit above the ground (a deck).
    const ceiling = (i: number): number =>
      layout === 'underground' && i > 0 && i < n - 1
        ? (heights[i] ?? 0) - cover(i)
        : Number.POSITIVE_INFINITY

    const cost = new Float64Array(n * levels).fill(Infinity)
    const parent = new Int32Array(n * levels).fill(-1)
    const readings = new Array<CellReading | undefined>(n * levels).fill(undefined)
    const at = (i: number, s: number): number => i * levels + (s - lo)
    const costAt = (i: number, s: number): number => cost[at(i, s)] ?? Infinity

    for (let i = 0; i < n; i += 1) {
      const col = path[i]
      if (col === undefined) continue
      const ground = heights[i] ?? 0
      let reason = 'blocked'
      let reachable = false
      for (let s = lo; s <= hi; s += 1) {
        if (i === 0 && s !== forcedFirst) continue
        if (i === n - 1 && s !== forcedLast) continue
        if (s > ceiling(i)) continue
        const read = this.readCell(col, s)
        if (typeof read === 'string') {
          if (Math.abs(s - ground) <= 1 || reason === 'blocked') reason = read
          continue
        }
        readings[at(i, s)] = read
        const shallow = Number.isFinite(ceiling(i)) ? 0.05 * (ceiling(i) - s) : 0
        const own = read.cost + shallow
        if (i === 0) {
          cost[at(i, s)] = own
          reachable = true
          continue
        }
        const mustBeFlat = isCorner(flat, i) || isCorner(flat, i - 1)
        for (const from of [s - 1, s, s + 1]) {
          if (from < lo || from > hi) continue
          if (from !== s && mustBeFlat) continue
          const total = costAt(i - 1, from) + own + (from === s ? 0 : SLOPE_COST)
          if (total < costAt(i, s)) {
            cost[at(i, s)] = total
            parent[at(i, s)] = from
            reachable = true
          }
        }
      }
      if (!reachable) {
        const spot = { x: col.x, y: ground + 1, z: col.z }
        return err({
          reason: reason === 'blocked' ? 'no_route' : reason,
          message: `The line cannot pass ${describe(spot)}: ${explain(reason)}.`,
          at: spot,
        })
      }
    }

    const chosen = new Array<number>(n).fill(forcedLast)
    let s = forcedLast
    let cuts = 0
    let decks = 0
    for (let i = n - 1; i >= 0; i -= 1) {
      chosen[i] = s
      const read = readings[at(i, s)]
      cuts += read?.cuts ?? 0
      decks += read?.decks ?? 0
      s = parent[at(i, s)] ?? s
    }
    const cells = path.map((col, i) => ({ x: col.x, y: (chosen[i] ?? 0) + 1, z: col.z }))
    return ok({
      cells,
      layout,
      cuts,
      decks,
      cost: costAt(n - 1, forcedLast),
      cover: cells.map((_, i) => cover(i)),
    })
  }

  /** What putting a rail on top of a support block at `s` costs in this column, or the reason it cannot be done. */
  private readCell(col: Col, s: number): CellReading | string {
    const { blocks } = this.deps
    const support = blocks.blockAt({ x: col.x, y: s, z: col.z })
    const rail = blocks.blockAt({ x: col.x, y: s + 1, z: col.z })
    const head = blocks.blockAt({ x: col.x, y: s + 2, z: col.z })
    if (support === undefined || rail === undefined || head === undefined) return 'unloaded'
    if (isRailName(support) || isRailName(rail) || isRailName(head)) return 'existing_rail'
    if (support === 'lava') return 'lava'
    for (const delta of LATERAL) {
      const beside = blocks.blockAt({ x: col.x + delta.x, y: s + 1, z: col.z + delta.z })
      if (beside === 'lava') return 'lava'
    }

    let cuts = 0
    let cost = 0
    for (const name of [rail, head]) {
      const kind = cutKind(name)
      if (kind === 'water' || kind === 'lava' || kind === 'blocked') return kind
      if (kind === 'cut') {
        cuts += 1
        cost += isTreePart(name) && !name.endsWith('_leaves') ? LOG_CUT_COST : CUT_COST
      }
    }
    if (cuts > 0) {
      const above = blocks.blockAt({ x: col.x, y: s + 3, z: col.z })
      if (above !== undefined && FALLING.has(above)) cost += FALLING_OVERHEAD_COST
    }
    const deck = isOpenAir(support) || isReplaceable(support) || isPassThrough(support)
    return { cost: cost + (deck ? DECK_COST : 0), cuts, decks: deck ? 1 : 0 }
  }
}

const isPassThrough = (name: string): boolean =>
  isVegetation(name) || isTreePart(name) || name === 'snow'

type CutKind = 'free' | 'cut' | 'water' | 'lava' | 'blocked'

/** What a block in the rail cell or the headroom means for the line. */
function cutKind(name: string): CutKind {
  if (name === 'water') return 'water'
  if (name === 'lava') return 'lava'
  if (isOpenAir(name) || isReplaceable(name)) return 'free'
  if (isNaturalTerrain(name) || isVegetation(name) || isTreePart(name)) return 'cut'
  return 'blocked'
}

const REASONS: Readonly<Record<string, string>> = {
  lava: 'there is lava in the way',
  water: 'the rail would sit in water',
  blocked: 'something somebody built is in the way',
  existing_rail: 'there is a railway there already',
  unloaded: 'the terrain there is not loaded',
}

const explain = (reason: string): string =>
  REASONS[reason] ?? 'no level works there (too steep, or too much in the way)'

export const describe = (position: Position): string =>
  `${String(position.x)}, ${String(position.y)}, ${String(position.z)}`
