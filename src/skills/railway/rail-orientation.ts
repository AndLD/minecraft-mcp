import type { Position } from '../../core/position.types.js'

export type Heading = 'north' | 'south' | 'east' | 'west'

/** North is -z, south +z, east +x, west -x. */
export function headingOf(from: Position, to: Position): Heading | undefined {
  if (to.x === from.x + 1 && to.z === from.z) return 'east'
  if (to.x === from.x - 1 && to.z === from.z) return 'west'
  if (to.z === from.z + 1 && to.x === from.x) return 'south'
  if (to.z === from.z - 1 && to.x === from.x) return 'north'
  return undefined
}

export const STEP: Readonly<Record<Heading, { readonly x: number; readonly z: number }>> = {
  north: { x: 0, z: -1 },
  south: { x: 0, z: 1 },
  east: { x: 1, z: 0 },
  west: { x: -1, z: 0 },
}

export const OPPOSITE: Readonly<Record<Heading, Heading>> = {
  north: 'south',
  south: 'north',
  east: 'west',
  west: 'east',
}

const CURVES: Readonly<Record<string, string>> = {
  'east,south': 'south_east',
  'south,west': 'south_west',
  'north,west': 'north_west',
  'east,north': 'north_east',
}

/**
 * The shape a rail at `cells[index]` takes once its neighbours are in: a straight run along an axis, a slope that
 * rises towards the higher neighbour, or a curve where the line turns. The game works this out itself as rails are
 * placed next to each other; this says what it should come to, so the result can be checked.
 */
export function expectedShape(cells: readonly Position[], index: number): string | undefined {
  const here = cells[index]
  if (here === undefined) return undefined
  const links: { readonly heading: Heading; readonly dy: number }[] = []
  for (const other of [cells[index - 1], cells[index + 1]]) {
    if (other === undefined) continue
    const heading = headingOf(here, other)
    if (heading === undefined) return undefined
    links.push({ heading, dy: other.y - here.y })
  }
  const higher = links.find((link) => link.dy > 0)
  if (higher !== undefined) return `ascending_${higher.heading}`
  const [first, second] = links
  if (first === undefined) return undefined
  if (second === undefined || first.heading === OPPOSITE[second.heading]) {
    return first.heading === 'east' || first.heading === 'west' ? 'east_west' : 'north_south'
  }
  return CURVES[[first.heading, second.heading].sort().join(',')]
}

/** Whether the rail at `index` is a corner: its two neighbours do not lie on one straight line. */
export function isCorner(cells: readonly Position[], index: number): boolean {
  const here = cells[index]
  const before = cells[index - 1]
  const after = cells[index + 1]
  if (here === undefined || before === undefined || after === undefined) return false
  const a = headingOf(here, before)
  const b = headingOf(here, after)
  return a !== undefined && b !== undefined && a !== OPPOSITE[b]
}
