import { z } from 'zod'
import type { Blueprint, BlueprintProvider, Placement } from '../blueprint.types.js'
import { MAX_SIDE } from './dimensions.js'

/** Characters that mean "nothing here". */
const EMPTY = new Set(['.', ' '])
const MAX_BLOCKS = 4000

const customParams = z
  .object({
    layers: z
      .array(z.array(z.string().max(MAX_SIDE)).min(1).max(MAX_SIDE))
      .min(1)
      .max(MAX_SIDE)
      .describe(
        'The layers from the bottom up. Each layer is a list of rows from north (z = 0) to south; each character of a row is one block from west (x = 0) to east.',
      ),
    legend: z
      .record(z.string().length(1), z.string().min(1))
      .describe(
        'What each character means: an item name, for example {"#": "stone_bricks", "D": "oak_door", "T": "torch"}. "." and a space mean nothing.',
      ),
    name: z.string().min(1).max(40).default('custom').describe('A name for messages.'),
  })
  .superRefine((value, context) => {
    let blocks = 0
    for (const layer of value.layers)
      for (const row of layer) for (const char of row) if (!EMPTY.has(char)) blocks += 1
    if (blocks > MAX_BLOCKS)
      context.addIssue({
        code: 'custom',
        message: `the blueprint has ${String(blocks)} blocks; the limit is ${String(MAX_BLOCKS)}`,
      })
    for (const [z0, layer] of value.layers.entries())
      for (const [row, text] of layer.entries())
        for (const char of text)
          if (!EMPTY.has(char) && !(char in value.legend))
            context.addIssue({
              code: 'custom',
              message: `layer ${String(z0)}, row ${String(row)} uses "${char}", which the legend does not define`,
            })
  })

/**
 * A blueprint the agent writes out in the call itself, as rows of characters and a legend: any shape, no fixed
 * catalogue needed. Doors are recognised by name (`*_door`) and placed last, aligned with the wall they stand in.
 */
export class CustomBlueprintProvider implements BlueprintProvider<z.output<typeof customParams>> {
  readonly name = 'custom'
  readonly description =
    'Any shape you describe yourself: `layers` (bottom to top, each a list of rows north to south, each character a block ' +
    'west to east) and a `legend` mapping characters to item names; "." and a space are empty. Doors (any *_door item) are ' +
    'placed last and turned to fit their wall. At most 32 blocks along each side and 4000 blocks in total. The lowest layer ' +
    'sits at the origin height. Save a design you like with remember so it can be built again.'
  readonly params = customParams

  generate(p: z.output<typeof customParams>): Blueprint {
    const filled = new Set<string>()
    const key = (dx: number, dy: number, dz: number): string =>
      `${String(dx)},${String(dy)},${String(dz)}`
    const placements: Placement[] = []
    const doors: Placement[] = []
    let width = 0
    let depth = 0
    for (const [dy, layer] of p.layers.entries())
      for (const [dz, row] of layer.entries()) {
        depth = Math.max(depth, dz + 1)
        for (const [dx, char] of row.split('').entries()) {
          width = Math.max(width, dx + 1)
          const block = p.legend[char]
          if (EMPTY.has(char) || block === undefined) continue
          filled.add(key(dx, dy, dz))
          placements.push({ dx, dy, dz, block })
        }
      }
    const ordered = placements.filter((cell) => {
      if (!cell.block.endsWith('_door')) return true
      // A door stands in a wall: if the wall continues along x on both sides, the bot must line up along z.
      const inXWall =
        filled.has(key(cell.dx - 1, cell.dy, cell.dz)) ||
        filled.has(key(cell.dx + 1, cell.dy, cell.dz))
      doors.push({ ...cell, alignAxis: inXWall ? 'z' : 'x' })
      return false
    })
    return {
      name: p.name,
      placements: [...ordered, ...doors],
      lights: [],
      size: { width, height: p.layers.length, depth },
    }
  }
}
