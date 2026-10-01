import type { BiomeReader } from '../../core/biome.port.js'
import type { Position } from '../../core/position.types.js'
import type { Random } from '../../core/random.port.js'
import type { BiomeRule } from '../../knowledge/structure-biomes/structure-biome-table.types.js'
import type { ExplorationState, ExplorationStrategy } from './exploration-strategy.types.js'
import { cellOf, FrontierExplorer, keyOf, WAYPOINT_STEP } from './exploration-strategies.js'

/** How far from the bot a matching biome is looked for beyond the ground next to what it has visited. */
const SIGHT = 128

/** How well a place fits the search, best (lowest) first. */
const Fit = {
  /** A biome the structure generates in. */
  Matching: 0,
  /** A biome that borders a matching one. */
  Neighbour: 1,
  /** A biome unlike the one the bot is in: a new biome is the only way to reach a matching one. */
  Different: 2,
  /** The same biome as here, or one that is not loaded. */
  Plain: 3,
} as const
type Fit = (typeof Fit)[keyof typeof Fit]

interface Cell {
  readonly i: number
  readonly j: number
}

/**
 * Searches for a structure by the biome it generates in. Among the places next to ground already visited it prefers a
 * matching biome, then one that borders a matching biome, then any biome unlike the current one (the edge of the
 * biome the bot is stuck in); a matching biome in view, even far from the visited ground, is headed for at once, and
 * biomes the structure can never be in are not searched at all. When nothing is left it falls back to the blob-growing
 * frontier search, so it is never worse than that. Ties are broken by the injected `Random`.
 */
export class BiomeGuidedExplorer implements ExplorationStrategy {
  private readonly fallback: FrontierExplorer

  constructor(
    private readonly biomes: BiomeReader,
    private readonly rule: BiomeRule,
    private readonly random: Random,
    private readonly step = WAYPOINT_STEP,
  ) {
    this.fallback = new FrontierExplorer(random, step)
  }

  nextWaypoint(state: ExplorationState): Position | null {
    const seen = new Set<string>()
    const visited: Cell[] = []
    for (const place of state.visited) {
      const cell = cellOf(place, state.origin, this.step)
      if (!seen.has(keyOf(cell.i, cell.j))) {
        seen.add(keyOf(cell.i, cell.j))
        visited.push(cell)
      }
    }
    const here = cellOf(state.current, state.origin, this.step)
    const y = Math.round(state.current.y)
    const biomeOf = (cell: Cell): string | undefined =>
      this.biomes.biomeAt({
        x: Math.round(state.origin.x + cell.i * this.step),
        y,
        z: Math.round(state.origin.z + cell.j * this.step),
      })
    const within = (cell: Cell): boolean =>
      Math.hypot(cell.i, cell.j) * this.step <= state.maxDistance
    const currentBiome = biomeOf(here)

    const candidates = new Map<string, { cell: Cell; fit: Fit }>()
    const consider = (cell: Cell, farAway: boolean): void => {
      const key = keyOf(cell.i, cell.j)
      if (seen.has(key) || candidates.has(key) || !within(cell)) return
      const fit = this.fitOf(biomeOf(cell), currentBiome)
      if (fit === undefined) return
      if (farAway && fit !== Fit.Matching) return
      candidates.set(key, { cell, fit })
    }
    for (const cell of visited)
      for (let di = -1; di <= 1; di += 1)
        for (let dj = -1; dj <= 1; dj += 1) consider({ i: cell.i + di, j: cell.j + dj }, false)
    const reach = Math.ceil(SIGHT / this.step)
    for (let di = -reach; di <= reach; di += 1)
      for (let dj = -reach; dj <= reach; dj += 1) consider({ i: here.i + di, j: here.j + dj }, true)

    const cost = (cell: Cell): number =>
      Math.hypot(cell.i, cell.j) + Math.hypot(cell.i - here.i, cell.j - here.j)
    let best: { cell: Cell; fit: Fit; cost: number }[] = []
    for (const { cell, fit } of candidates.values()) {
      const entry = { cell, fit, cost: cost(cell) }
      const top = best[0]
      if (top === undefined || fit < top.fit || (fit === top.fit && entry.cost < top.cost - 1e-6))
        best = [entry]
      else if (fit === top.fit && Math.abs(entry.cost - top.cost) < 1e-6) best.push(entry)
    }
    const pick = best[Math.floor(this.random.next() * best.length)]
    if (pick === undefined) return this.fallback.nextWaypoint(state)
    return {
      x: state.origin.x + pick.cell.i * this.step,
      y: state.current.y,
      z: state.origin.z + pick.cell.j * this.step,
    }
  }

  /** undefined: a biome the structure can never be in, which is not searched. */
  private fitOf(biome: string | undefined, current: string | undefined): Fit | undefined {
    if (biome === undefined) return Fit.Plain
    if ((this.rule.never ?? []).includes(biome)) return undefined
    if (this.rule.biomes.includes(biome)) return Fit.Matching
    if ((this.rule.neighbours ?? []).includes(biome)) return Fit.Neighbour
    return biome !== current ? Fit.Different : Fit.Plain
  }
}
