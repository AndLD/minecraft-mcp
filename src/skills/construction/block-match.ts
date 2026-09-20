/** Blocks a placed block simply replaces, so a cell holding one counts as free. */
const REPLACEABLE = new Set([
  'air',
  'cave_air',
  'void_air',
  'short_grass',
  'grass',
  'tall_grass',
  'fern',
  'large_fern',
  'dead_bush',
  'snow',
  'vine',
  'water',
])

const OPEN = new Set(['air', 'cave_air', 'void_air'])

export const isOpenAir = (name: string | undefined): boolean => name !== undefined && OPEN.has(name)

/** A cell that a block can be placed into without breaking anything first. */
export const isReplaceable = (name: string | undefined): boolean =>
  name !== undefined && REPLACEABLE.has(name)

/** Whether the block found in a cell is the one that was meant to be placed (a torch on a wall is a wall torch). */
/** Buckets do not place a block of their own name: the water bucket makes water. */
const BUCKET_BLOCKS: Readonly<Record<string, string>> = {
  water_bucket: 'water',
  lava_bucket: 'lava',
}

export function isPlanned(planned: string, found: string | undefined): boolean {
  if (found === undefined) return false
  if (found === planned) return true
  if (BUCKET_BLOCKS[planned] === found) return true
  if (planned.endsWith('torch')) return found === planned.replace('torch', 'wall_torch')
  return false
}
