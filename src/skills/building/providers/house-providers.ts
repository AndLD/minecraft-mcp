import { z } from 'zod'
import type { Blueprint, BlueprintProvider, Placement } from '../blueprint.types.js'
import { blockParam, fill, outline } from './dimensions.js'

const HOUSE_MAX_SIDE = 24
const houseSide = (what: string) =>
  z
    .number()
    .int()
    .min(3)
    .max(HOUSE_MAX_SIDE)
    .describe(`${what}, in blocks (3 to ${String(HOUSE_MAX_SIDE)}).`)

/** Cells where an opening goes: one column of the wall at z = 0, two blocks high. */
const isDoorway = (p: Placement, doorX: number, floorLayers: number): boolean =>
  p.dz === 0 && p.dx === doorX && p.dy >= floorLayers && p.dy < floorLayers + 2

const houseParams = z.object({
  width: houseSide('Size along the x axis (east-west)'),
  depth: houseSide('Size along the z axis (north-south)'),
  height: z
    .number()
    .int()
    .min(3)
    .max(8)
    .default(3)
    .describe('Height of the walls in blocks (3 to 8, default 3); the floor and roof come on top.'),
  wall_block: blockParam('oak_planks'),
  floor_block: z.string().min(1).optional().describe('Floor material (default: the wall block).'),
  roof_block: z.string().min(1).optional().describe('Roof material (default: the wall block).'),
  door: z
    .string()
    .min(1)
    .default('oak_door')
    .describe('Item name of the door placed in the doorway (default oak_door).'),
  windows: z
    .boolean()
    .default(false)
    .describe(
      'Put a window in the middle of the west, east, and south walls (one block, at eye level).',
    ),
  window_block: z
    .string()
    .min(1)
    .default('glass_pane')
    .describe('Window material (default glass_pane).'),
  lit: z
    .boolean()
    .default(true)
    .describe(
      'Put torches inside, one for every 5×5 blocks of floor, when there are torches in the inventory.',
    ),
})

/**
 * A small house: floor, walls, a flat roof, a doorway with a real door in the north wall (the wall at z = the
 * origin), optional windows, and torches. The door is placed last, from the side, so it lies in the doorway.
 */
export class SmallHouseProvider implements BlueprintProvider<z.output<typeof houseParams>> {
  readonly name = 'house'
  readonly description =
    'A small house: a floor, walls, a flat roof, a door in the north wall (z = the origin) that the bot can walk through, ' +
    'optional windows, and torches inside. The lowest layer (the floor) sits at the origin height. Needs the door item ' +
    '(oak_door by default) as well as the building blocks.'
  readonly params = houseParams

  generate(p: z.output<typeof houseParams>): Blueprint {
    const doorX = Math.floor(p.width / 2)
    const placements: Placement[] = [...fill(p.width, p.depth, 0, p.floor_block ?? p.wall_block)]
    const windowCells = new Set<string>()
    if (p.windows && p.height >= 3) {
      const eye = 2 // the layer at eye level: floor 0, walls from 1
      const midZ = Math.floor(p.depth / 2)
      windowCells.add(`0,${String(eye)},${String(midZ)}`)
      windowCells.add(`${String(p.width - 1)},${String(eye)},${String(midZ)}`)
      windowCells.add(`${String(doorX)},${String(eye)},${String(p.depth - 1)}`)
    }
    for (let dy = 1; dy <= p.height; dy += 1)
      for (const cell of outline(p.width, p.depth, dy, p.wall_block)) {
        if (isDoorway(cell, doorX, 1)) continue
        const isWindow = windowCells.has(`${String(cell.dx)},${String(cell.dy)},${String(cell.dz)}`)
        placements.push(isWindow ? { ...cell, block: p.window_block } : cell)
      }
    placements.push(...fill(p.width, p.depth, p.height + 1, p.roof_block ?? p.wall_block))
    // The door goes last, from the side: its orientation follows where the bot looks.
    placements.push({ dx: doorX, dy: 1, dz: 0, block: p.door, alignAxis: 'z' })

    const lights = []
    if (p.lit)
      for (let dx = 1; dx < p.width - 1; dx += 5)
        for (let dz = 1; dz < p.depth - 1; dz += 5) lights.push({ dx, dy: 1, dz })
    return {
      name: `house ${String(p.width)}x${String(p.depth)}x${String(p.height)}`,
      placements,
      lights,
      size: { width: p.width, height: p.height + 2, depth: p.depth },
    }
  }
}

const shelterParams = z.object({ block: blockParam('cobblestone') })

/**
 * An emergency shelter built around the bot: a 1×2 room with walls two blocks high and a roof, sealed, with the bot
 * inside. It is meant for holding out a night or a fight when there is nothing else, not for living in.
 */
export class ShelterProvider implements BlueprintProvider<z.output<typeof shelterParams>> {
  readonly name = 'shelter'
  readonly description =
    'An emergency shelter built AROUND the bot where it stands (no origin needed): a room one block wide and two long, ' +
    'walls two high, and a roof, all sealed, with the bot inside; about 32 blocks of any cheap block (cobblestone by ' +
    'default, dirt works). To leave, break a wall block from the inside (collect_block on it). Use it to survive a night ' +
    'or a fight far from home; it has no door and no floor, so do not use it as a house.'
  readonly params = shelterParams

  generate(p: z.output<typeof shelterParams>): Blueprint {
    const placements: Placement[] = []
    for (let dy = 0; dy < 2; dy += 1) placements.push(...outline(3, 4, dy, p.block))
    placements.push(...fill(3, 4, 2, p.block))
    return {
      name: 'shelter',
      placements,
      lights: [],
      size: { width: 3, height: 3, depth: 4 },
      standing: 'inside',
      // The bot stands in the middle column, one cell in from the north wall.
      anchor: { dx: 1, dy: 0, dz: 1 },
    }
  }
}
