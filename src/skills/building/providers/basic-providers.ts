import { z } from 'zod'
import type { Blueprint, BlueprintProvider } from '../blueprint.types.js'
import { blockParam, depthParam, fill, heightParam, outline, widthParam } from './dimensions.js'

const floorParams = z.object({
  width: widthParam,
  depth: depthParam,
  block: blockParam('cobblestone'),
})

/** A flat rectangle, one block thick. */
export class FloorProvider implements BlueprintProvider<z.output<typeof floorParams>> {
  readonly name = 'floor'
  readonly description =
    'A flat rectangle one block thick, with its lowest corner at the origin (the layer sits at the origin height).'
  readonly params = floorParams

  generate(p: z.output<typeof floorParams>): Blueprint {
    return {
      name: `floor ${String(p.width)}x${String(p.depth)}`,
      placements: fill(p.width, p.depth, 0, p.block),
      lights: [],
      size: { width: p.width, height: 1, depth: p.depth },
    }
  }
}

const wallsParams = z.object({
  width: widthParam,
  depth: depthParam,
  height: heightParam,
  block: blockParam('cobblestone'),
})

/** The outline of a rectangle, `height` blocks tall: no floor, no roof, no opening. */
export class WallsProvider implements BlueprintProvider<z.output<typeof wallsParams>> {
  readonly name = 'walls'
  readonly description =
    'Walls around a rectangle, `height` blocks tall, with no floor, roof, or door. The lowest layer sits at the origin height.'
  readonly params = wallsParams

  generate(p: z.output<typeof wallsParams>): Blueprint {
    const placements = []
    for (let dy = 0; dy < p.height; dy += 1)
      placements.push(...outline(p.width, p.depth, dy, p.block))
    return {
      name: `walls ${String(p.width)}x${String(p.depth)}x${String(p.height)}`,
      placements,
      lights: [],
      size: { width: p.width, height: p.height, depth: p.depth },
    }
  }
}

const solidParams = z.object({
  width: widthParam,
  depth: depthParam,
  height: heightParam,
  block: blockParam('cobblestone'),
})

/** A filled cuboid: a pillar, a platform, a block of stairs' base. */
export class SolidProvider implements BlueprintProvider<z.output<typeof solidParams>> {
  readonly name = 'solid'
  readonly description =
    'A completely filled cuboid (a pillar, a platform, a foundation). The lowest layer sits at the origin height.'
  readonly params = solidParams

  generate(p: z.output<typeof solidParams>): Blueprint {
    const placements = []
    for (let dy = 0; dy < p.height; dy += 1) placements.push(...fill(p.width, p.depth, dy, p.block))
    return {
      name: `solid ${String(p.width)}x${String(p.depth)}x${String(p.height)}`,
      placements,
      lights: [],
      size: { width: p.width, height: p.height, depth: p.depth },
    }
  }
}

const blockParams = z.object({ block: blockParam('cobblestone') })

/** One block: what `place_block` uses. */
export class SingleBlockProvider implements BlueprintProvider<z.output<typeof blockParams>> {
  readonly name = 'block'
  readonly description = 'A single block at the origin.'
  readonly params = blockParams

  generate(p: z.output<typeof blockParams>): Blueprint {
    return {
      name: `block ${p.block}`,
      placements: [{ dx: 0, dy: 0, dz: 0, block: p.block }],
      lights: [],
      size: { width: 1, height: 1, depth: 1 },
    }
  }
}

const DOORWAY_HEIGHT = 2

const boxParams = z.object({
  width: widthParam,
  depth: depthParam,
  height: heightParam.describe(
    'Height of the walls in blocks (1 to 32); the floor and roof come on top of it.',
  ),
  wall_block: blockParam('cobblestone'),
  floor_block: z.string().min(1).optional().describe('Floor material (default: the wall block).'),
  roof_block: z.string().min(1).optional().describe('Roof material (default: the wall block).'),
  floor: z.boolean().default(true).describe('Build a floor (one layer at the origin height).'),
  roof: z.boolean().default(true).describe('Build a roof (one layer on top of the walls).'),
  doorway: z
    .boolean()
    .default(true)
    .describe(
      'Leave a 1 block wide, 2 high opening in the wall at z = the origin (the north side), so the room can be entered and left. Set false for a sealed room.',
    ),
  lit: z
    .boolean()
    .default(false)
    .describe(
      'Put torches inside, one for every 5×5 blocks of floor, when there are torches in the inventory.',
    ),
})

/** A room: floor, walls, roof, and by default a doorway (no door itself: the house blueprints add one). */
export class BoxProvider implements BlueprintProvider<z.output<typeof boxParams>> {
  readonly name = 'box'
  readonly description =
    'A closed room: an optional floor layer at the origin height, walls of `height` blocks above it, and an optional roof layer. ' +
    'By default it has a 1×2 doorway (no door) in the wall at z = the origin, so it can be entered; it has no windows.'
  readonly params = boxParams

  generate(p: z.output<typeof boxParams>): Blueprint {
    const placements = []
    const base = p.floor ? 1 : 0
    if (p.floor) placements.push(...fill(p.width, p.depth, 0, p.floor_block ?? p.wall_block))
    const doorX = Math.floor(p.width / 2)
    for (let dy = 0; dy < p.height; dy += 1)
      placements.push(
        ...outline(p.width, p.depth, base + dy, p.wall_block).filter(
          (cell) => !(p.doorway && cell.dz === 0 && cell.dx === doorX && dy < DOORWAY_HEIGHT),
        ),
      )
    const top = base + p.height
    if (p.roof) placements.push(...fill(p.width, p.depth, top, p.roof_block ?? p.wall_block))

    const lights = []
    if (p.lit && p.width > 2 && p.depth > 2)
      for (let dx = 1; dx < p.width - 1; dx += 5)
        for (let dz = 1; dz < p.depth - 1; dz += 5) lights.push({ dx, dy: base, dz })
    return {
      name: `box ${String(p.width)}x${String(p.depth)}x${String(p.height)}`,
      placements,
      lights,
      size: { width: p.width, height: top + (p.roof ? 1 : 0), depth: p.depth },
    }
  }
}
