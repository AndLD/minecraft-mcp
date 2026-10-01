export interface TreeSpec {
  readonly name: string
  readonly sapling: string
  readonly log: string
  /** Least distance (blocks, both axes) between the spots of two trees, so their canopies and trunks have room. */
  readonly spacing: number
  /** How many free cells the game wants above the sapling for the tree to grow. */
  readonly clearance: number
  /** Only grows from four saplings in a 2x2 (a single sapling never grows). */
  readonly forceBig: boolean
  /** May grow into the big variant from four saplings in a 2x2. */
  readonly canBig: boolean
  /** Spacing and clearance for the 2x2 variant. */
  readonly bigSpacing: number
  readonly bigClearance: number
}

const tree = (
  name: string,
  spacing: number,
  clearance: number,
  big?: { readonly forced: boolean; readonly spacing: number; readonly clearance: number },
): TreeSpec => ({
  name,
  sapling: `${name}_sapling`,
  log: `${name}_log`,
  spacing,
  clearance,
  forceBig: big?.forced ?? false,
  canBig: big !== undefined,
  bigSpacing: big?.spacing ?? spacing,
  bigClearance: big?.clearance ?? clearance,
})

const TREES: readonly TreeSpec[] = [
  tree('oak', 4, 7),
  tree('birch', 4, 8),
  tree('spruce', 4, 9, { forced: false, spacing: 7, clearance: 14 }),
  tree('jungle', 4, 8, { forced: false, spacing: 8, clearance: 16 }),
  tree('acacia', 5, 8),
  tree('dark_oak', 7, 10, { forced: true, spacing: 7, clearance: 10 }),
  tree('cherry', 5, 8),
]

/** Every sapling item the table knows. */
export const SAPLING_ITEMS: readonly string[] = TREES.map((spec) => spec.sapling)

/** The leaf block of a species: breaking it by hand is what drops that species' sapling. */
export const leavesOf = (spec: TreeSpec): string => `${spec.name}_leaves`

/**
 * The one species a set of block names is about (`oak_log` -> oak), or undefined when it is none or several (a
 * group such as `logs`, or oak and birch together).
 */
export function speciesOfBlocks(names: readonly string[]): TreeSpec | undefined {
  const found = new Set<TreeSpec>()
  for (const name of names) {
    const spec = speciesOfLog(name)
    if (spec === undefined) return undefined
    found.add(spec)
  }
  const [only] = found
  return found.size === 1 ? only : undefined
}

export const TREE_NAMES = TREES.map((spec) => spec.name) as [string, ...string[]]

/** The tree species by its name (`oak`), sapling item (`oak_sapling`), or log block (`oak_log`). */
export function treeFor(nameOrItem: string): TreeSpec | undefined {
  return TREES.find(
    (spec) => spec.name === nameOrItem || spec.sapling === nameOrItem || spec.log === nameOrItem,
  )
}

export const isLogName = (name: string): boolean => /^(?!stripped_).+_log$/.test(name)
export const isSaplingName = (name: string): boolean => name.endsWith('_sapling')
export const isLeavesName = (name: string): boolean => name.endsWith('_leaves')

/** The species a log block belongs to (`dark_oak_log` -> dark_oak), when it is one this can plant. */
export function speciesOfLog(logName: string): TreeSpec | undefined {
  return TREES.find((spec) => spec.log === logName)
}

const GROUND = new Set([
  'dirt',
  'grass_block',
  'podzol',
  'coarse_dirt',
  'rooted_dirt',
  'mud',
  'moss_block',
])

/** Blocks a sapling can stand on. */
export const isPlantableGround = (name: string): boolean => GROUND.has(name)

const PASS_THROUGH =
  /^(air|cave_air|void_air|short_grass|grass|tall_grass|fern|large_fern|dead_bush|dandelion|poppy|blue_orchid|allium|azure_bluet|(red|orange|white|pink)_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|vine)$/

/** Air and small plants: a tree can grow through them and a sapling can replace them. */
export const isPassThrough = (name: string): boolean => PASS_THROUGH.test(name)

export const isTreeAvoidedNeighbour = (name: string): boolean =>
  name === 'dirt_path' ||
  name === 'farmland' ||
  name.endsWith('_door') ||
  name.endsWith('_fence_gate') ||
  name.endsWith('_trapdoor')

/** A tall tree reaches about this far above its sapling; protection around a grove covers it. */
export const MAX_TREE_HEIGHT = 24
