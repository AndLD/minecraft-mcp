import type { BlockScanner } from '../../core/block-scanner.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import { bedPosition, type BedRegistry } from '../../state/bed-registry.js'
import { BED_NAMES, colourOfBed, isBedName } from './bed-table.js'

/** How far the bot looks for beds it has not been told about. */
const SEARCH_RADIUS = 32

export interface BedChoice {
  readonly position: Position
  readonly colour: string
}

/** Finds the beds the bot can use: the ones it remembers (dropping any that are gone) and the ones it can see. */
export class BedFinder {
  constructor(
    private readonly blocks: BlockScanner,
    private readonly registry: BedRegistry,
  ) {}

  /** Beds to try, nearest to `from` first. */
  candidates(from: Position): readonly BedChoice[] {
    const found: BedChoice[] = []
    for (const bed of this.registry.nearest(from)) {
      const position = bedPosition(bed)
      const name = this.blocks.blockAt(position)
      // An unloaded place says nothing: the bed may well be there.
      if (name === undefined || isBedName(name)) found.push({ position, colour: bed.colour })
      else this.registry.remove(bed.id)
    }
    for (const block of this.blocks.findBlocks({
      names: BED_NAMES,
      maxDistance: SEARCH_RADIUS,
      count: 20,
    })) {
      const colour = colourOfBed(block.name)
      const twin = found.some(
        (choice) =>
          choice.position.y === block.position.y &&
          Math.abs(choice.position.x - block.position.x) +
            Math.abs(choice.position.z - block.position.z) <=
            1,
      )
      if (!twin) found.push({ position: block.position, colour })
    }
    return found.sort(
      (a, b) => distanceBetween(from, a.position) - distanceBetween(from, b.position),
    )
  }
}
