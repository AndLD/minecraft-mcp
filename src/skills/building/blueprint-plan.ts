import type { Position } from '../../core/position.types.js'
import type { WorkPlan } from '../construction/work-plan.types.js'
import type { Blueprint } from './blueprint.types.js'

/** Where torches count as dark enough to need one. */
const MIN_LIGHT = 8

/** Turns a blueprint into a plan at a place: `origin` is the blueprint's lowest corner (smallest x, y, and z). */
export function planFor(blueprint: Blueprint, origin: Position): WorkPlan {
  const cell = (dx: number, dy: number, dz: number): Position => ({
    x: origin.x + dx,
    y: origin.y + dy,
    z: origin.z + dz,
  })
  return {
    name: blueprint.name,
    ...(blueprint.standing === undefined ? {} : { standing: blueprint.standing }),
    steps: [
      ...blueprint.placements.map((p) => ({
        kind: 'place' as const,
        at: cell(p.dx, p.dy, p.dz),
        block: p.block,
        ...(p.alignAxis === undefined ? {} : { alignAxis: p.alignAxis }),
      })),
      ...blueprint.lights.map((l) => ({
        kind: 'light' as const,
        at: cell(l.dx, l.dy, l.dz),
        minLight: MIN_LIGHT,
      })),
    ],
  }
}

/** The corners of the volume a blueprint occupies at an origin, for messages. */
export function boundsOf(blueprint: Blueprint, origin: Position): { from: Position; to: Position } {
  return {
    from: origin,
    to: {
      x: origin.x + blueprint.size.width - 1,
      y: origin.y + blueprint.size.height - 1,
      z: origin.z + blueprint.size.depth - 1,
    },
  }
}
