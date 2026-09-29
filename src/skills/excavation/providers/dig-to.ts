import { z } from 'zod'
import type { Position } from '../../../core/position.types.js'
import type { WorkPlan, WorkStep } from '../../construction/work-plan.types.js'
import type { ExcavationContext, ExcavationProvider } from '../excavation.types.js'
import { feetCell, negate, probeAllBut } from './geometry.js'
import { lightParams, sealFor, sealParams } from './tunnels.js'

const MAX_ROUTE = 256

const digToParams = z.object({
  target: z
    .object({
      x: z.number().int().describe('x block coordinate.'),
      y: z.number().int().describe('y block coordinate.'),
      z: z.number().int().describe('z block coordinate.'),
    })
    .describe(
      'The block to reach and break (an ore, a chest that is buried, ...). It is dug last.',
    ),
  ...lightParams,
  ...sealParams,
})

type DigToParams = z.output<typeof digToParams>

interface Column {
  readonly x: number
  readonly y: number
  readonly z: number
}

/**
 * The columns from the start to one short of the target's column: along x, then along z, one block at a time, going up
 * or down one block on the moves that need it (spread evenly), so the route is a walkable stair of at most one block per
 * step. Undefined when the target is too steep for the distance.
 */
function route(start: Position, target: Position): Column[] | { readonly error: string } {
  const columns: { x: number; z: number }[] = [{ x: start.x, z: start.z }]
  const stepX = Math.sign(target.x - start.x)
  for (let x = start.x; x !== target.x; x += stepX) columns.push({ x: x + stepX, z: start.z })
  const stepZ = Math.sign(target.z - start.z)
  for (let z = start.z; z !== target.z; z += stepZ) columns.push({ x: target.x, z: z + stepZ })
  // The last column is the target's own: the route ends beside it and the target is dug from there.
  columns.pop()
  const moves = columns.length - 1
  const rise = target.y - start.y
  if (columns.length === 0)
    return { error: 'The target is where the bot stands: nothing to dig a route through.' }
  if (Math.abs(rise) > Math.max(moves, 0))
    return {
      error: `The target is ${String(Math.abs(rise))} block(s) ${rise > 0 ? 'above' : 'below'} the start but only ${String(moves)} block(s) away sideways: a route climbs or drops one block per block, so it needs at least ${String(Math.abs(rise))} blocks of distance. Start further away, or dig a shaft or staircase_down first.`,
    }
  if (moves > MAX_ROUTE)
    return {
      error: `The route would be ${String(moves)} blocks long (at most ${String(MAX_ROUTE)}).`,
    }
  return columns.map((column, i) => ({
    x: column.x,
    z: column.z,
    y: start.y + (moves === 0 ? 0 : Math.round((rise * i) / moves)),
  }))
}

/**
 * A walkable route (a two-high tunnel, stepping up or down where the target is higher or lower) from where the bot
 * stands to a target block, and then the target itself. It uses the same rules as the other shapes: lava or water
 * beside a cell ends the route one block short, and so do caves, sand or gravel overhead (unless `falling_blocks:
 * "clear"`), spawners, chests, and rails. The steps come from `route` above.
 */
export class DigToProvider implements ExcavationProvider<DigToParams> {
  readonly name = 'dig_to'
  readonly description =
    'A route dug to one target block: a two-high tunnel from where the bot stands to the block at `target` (an ore vein, ' +
    'a buried chest), stepping up or down one block per block sideways, and then the target block itself is broken. The ' +
    "origin is the bot's feet cell. The target must be at least as far away sideways as it is above or below (else: " +
    'start further away, or dig a shaft first). Torches about every `torch_spacing` blocks; ore touching the route is ' +
    'mined too. It ends short, with the reason and place recorded, at lava or water, an open cave, sand or gravel ' +
    'overhead, a spawner, or a chest or rails, like a tunnel does.'
  readonly params = digToParams

  defaultOrigin(feet: Position): Position {
    return feetCell(feet)
  }

  generate(p: DigToParams, context: ExcavationContext): WorkPlan | { error: string } {
    const start = context.origin
    if (p.target.y < context.minY)
      return { error: `The target is below the lowest layer (${String(context.minY)}).` }
    const columns = route(start, p.target)
    if ('error' in columns) return columns
    const steps: WorkStep[] = []
    const first = columns[0]
    if (first === undefined) return { error: 'The route is empty.' }
    const seal = sealFor(p)

    for (let i = 0; i < columns.length; i += 1) {
      const column = columns[i]
      const before = columns[i - 1]
      const after = columns[i + 1]
      if (column === undefined) continue
      const descending = before !== undefined && column.y < before.y
      const ascending = before !== undefined && column.y > before.y
      const vertical = descending || ascending || (after !== undefined && after.y !== column.y)
      // Where the bot came from: the probe leaves that side out, as a tunnel's does.
      const back =
        before === undefined
          ? undefined
          : { x: Math.sign(before.x - column.x), y: 0, z: Math.sign(before.z - column.z) }
      const probe = back === undefined ? probeAllBut() : probeAllBut(back)
      const heights = vertical ? [0, 1, 2] : [0, 1]
      const ordered = descending ? [...heights].reverse() : heights
      let previous: Position | undefined
      for (const h of ordered) {
        const at = { x: column.x, y: column.y + h, z: column.z }
        // The start column is where the bot already stands: only what it needs to climb is dug there.
        if (i === 0 && !(ascending || vertical) && h < 2) continue
        const needs =
          previous !== undefined
            ? previous
            : before === undefined
              ? undefined
              : { x: before.x, y: Math.min(Math.max(at.y, before.y), before.y + 1), z: before.z }
        steps.push({
          kind: 'break',
          at,
          branch: 'route',
          probe,
          ...(needs === undefined ? {} : { needs }),
        })
        previous = at
      }
      if (p.torch_spacing > 0 && i > 0 && i % p.torch_spacing === 0)
        steps.push({
          kind: 'light',
          at: { x: column.x, y: column.y, z: column.z },
          minLight: p.min_light,
          spacing: p.torch_spacing,
          required: true,
          branch: 'route',
        })
    }

    const last = columns[columns.length - 1] ?? first
    const reach = { x: last.x, y: p.target.y, z: last.z }
    steps.push({
      kind: 'break',
      at: p.target,
      branch: 'route',
      needs: reach,
      probe: probeAllBut(
        negate({ x: Math.sign(p.target.x - last.x), y: 0, z: Math.sign(p.target.z - last.z) }),
      ),
    })

    return {
      name: `route to ${String(p.target.x)}, ${String(p.target.y)}, ${String(p.target.z)}`,
      steps,
      standing: 'inside',
      hazards: 'end_branch',
      cavityCheck: true,
      veins: { maxSize: 64 },
      seal,
    }
  }
}
