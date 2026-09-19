import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Position } from '../../core/position.types.js'

const HAZARDS = ['lava', 'fire', 'magma_block', 'cactus']

/** Decides whether a place is fit for throwing items down: solid ground, and no lava or water underfoot. */
export class DropSpot {
  constructor(private readonly blocks: BlockScanner) {}

  /** A description of what is wrong with the spot, or undefined when it is fine. */
  problemAt(position: Position): string | undefined {
    const feet = {
      x: Math.floor(position.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z),
    }
    const below = { ...feet, y: feet.y - 1 }
    const here = this.blocks.blockAt(feet) ?? ''
    const under = this.blocks.blockAt(below) ?? ''

    for (const name of [here, under])
      if (HAZARDS.some((hazard) => name.includes(hazard))) return `there is ${name} at the spot`
    if (here.includes('water') || under.includes('water'))
      return 'the spot is in water, where items float away'
    if (this.blocks.isSolid(below) === false)
      return 'there is no ground under the spot (a ledge or a drop)'
    return undefined
  }
}
