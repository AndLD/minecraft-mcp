import type { AreaGuard } from '../../../core/area-guard.port.js'
import type { BlockScanner } from '../../../core/block-scanner.port.js'
import type { Digger } from '../../../core/digger.port.js'
import type { Navigator } from '../../../core/navigator.port.js'
import { distanceBetween } from '../../../core/position.js'
import type { Position } from '../../../core/position.types.js'
import type { HazardRule } from '../../construction/hazard-rule.js'
import type { SeenFind } from './find-rules.js'

export type VeinOutcome =
  | { readonly kind: 'mined'; readonly count: number }
  /** Nothing was dug, and why. */
  | {
      readonly kind: 'skipped'
      readonly reason: 'hazard' | 'protected' | 'no_tool' | 'aborted'
      readonly count: number
    }

const MAX_VEIN = 24
const WITHIN = 3

const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`

/** Digs out one seen vein, block by block, under the same fluid and falling-block rules as every other dig. */
export class VeinMiner {
  constructor(
    private readonly deps: {
      readonly navigator: Navigator
      readonly digger: Digger
      readonly blocks: BlockScanner
      readonly hazards: HazardRule
      readonly areas: AreaGuard
    },
  ) {}

  async mine(find: SeenFind, from: Position, signal: AbortSignal): Promise<VeinOutcome> {
    const cells = this.wholeVein(find)
    for (const cell of cells) {
      if (this.deps.areas.protectedAt(cell) !== undefined)
        return { kind: 'skipped', reason: 'protected', count: 0 }
      if (this.deps.hazards.fluidNear(cell) !== undefined)
        return { kind: 'skipped', reason: 'hazard', count: 0 }
    }
    const first = cells[0]
    if (first === undefined) return { kind: 'mined', count: 0 }
    const assessed = this.deps.digger.assess(first)
    if (assessed !== undefined && !assessed.canHarvest)
      return { kind: 'skipped', reason: 'no_tool', count: 0 }

    let mined = 0
    for (const cell of [...cells].sort(
      (a, b) => distanceBetween(a, from) - distanceBetween(b, from),
    )) {
      if (signal.aborted) return { kind: 'skipped', reason: 'aborted', count: mined }
      if (this.deps.blocks.blockAt(cell) !== find.name) continue
      // Gravel or sand above would fall in; another block's neighbours may have turned to fluid since the check.
      if (this.deps.hazards.fallingAbove(cell) !== undefined) continue
      const trip = await this.deps.navigator.goToPosition(cell, WITHIN, { signal })
      if (!trip.ok) continue
      const dug = await this.deps.digger.dig(cell, signal)
      if (dug.ok) mined += 1
    }
    return { kind: 'mined', count: mined }
  }

  /** The seen cells plus any more of the same block joined to them, up to a limit. */
  private wholeVein(find: SeenFind): Position[] {
    const seen = new Set(find.cells.map(key))
    const cells = [...find.cells]
    for (let index = 0; index < cells.length && cells.length < MAX_VEIN; index += 1) {
      const cell = cells[index]
      if (cell === undefined) break
      for (let dx = -1; dx <= 1; dx += 1)
        for (let dy = -1; dy <= 1; dy += 1)
          for (let dz = -1; dz <= 1; dz += 1) {
            const next = { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz }
            if (seen.has(key(next)) || this.deps.blocks.blockAt(next) !== find.name) continue
            seen.add(key(next))
            cells.push(next)
          }
    }
    return cells.slice(0, MAX_VEIN)
  }
}
