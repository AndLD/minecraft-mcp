import type { BlockScanner } from '../../core/block-scanner.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import { classifySwitch, type SwitchKind } from './switch-table.js'

export interface SwitchCandidate {
  readonly position: Position
  readonly name: string
  readonly kind: SwitchKind
  /** Straight-line distance from the position searched around (not from the bot). */
  readonly distance: number
}

/** How far from the searched position a switch still counts as "beside it". */
export const SWITCH_SEARCH_RADIUS = 4

/**
 * `BlockScanner.findBlocks` only searches from the bot's own position (no "search from this other point" of
 * its own — the same limit `WallTarget`/`MarkerFinder`/`DoorOpeningNavigator` already live with). This margin
 * widens the bot-centred search so a bot standing right next to the target still has the target's whole
 * neighbourhood inside its own search radius.
 */
const BOT_SEARCH_MARGIN = 8

/** Finds buttons, levers, and plates near a position (typically a closed iron door), nearest first. */
export class SwitchFinder {
  constructor(private readonly blocks: BlockScanner) {}

  near(position: Position, radius: number = SWITCH_SEARCH_RADIUS): readonly SwitchCandidate[] {
    const names = this.blocks.knownBlockNames().filter((name) => classifySwitch(name) !== undefined)
    if (names.length === 0) return []
    const found = this.blocks.findBlocks({
      names,
      maxDistance: radius + BOT_SEARCH_MARGIN,
      count: 40,
    })
    const candidates: SwitchCandidate[] = []
    for (const info of found) {
      const kind = classifySwitch(info.name)
      if (kind === undefined) continue
      const distance = distanceBetween(info.position, position)
      if (distance > radius) continue
      candidates.push({ position: info.position, name: info.name, kind, distance })
    }
    return candidates.sort((a, b) => a.distance - b.distance)
  }
}
