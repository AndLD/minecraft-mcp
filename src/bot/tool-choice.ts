/** Fastest first among tools of the same kind. Gold digs quickly but only counts as a wooden tool for harvesting. */
const SPEED_ORDER = ['netherite', 'diamond', 'iron', 'golden', 'stone', 'wooden'] as const

const TOOL_KINDS = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword'] as const

export interface ToolChoiceInput {
  /** Names of the tools that make the block drop its items; empty when anything does. */
  readonly harvestTools: readonly string[]
  /** The block's material tag, for example `mineable/pickaxe` (possibly with other tags, split by `;`). */
  readonly material: string | undefined
  /** Item names in the inventory. */
  readonly carried: readonly string[]
}

export interface ToolChoice {
  readonly canHarvest: boolean
  /** Best tool to take in hand; undefined when bare hands are best. */
  readonly tool: string | undefined
}

const speedRank = (tool: string): number => {
  const index = SPEED_ORDER.findIndex((tier) => tool.startsWith(`${tier}_`))
  return index === -1 ? SPEED_ORDER.length : index
}

/** The tool kind that digs the block fastest, from its material tag. */
export function preferredKind(material: string | undefined): string | undefined {
  for (const tag of material?.split(';') ?? []) {
    const kind = /^mineable\/(\w+)$/.exec(tag)?.[1]
    if (kind !== undefined && (TOOL_KINDS as readonly string[]).includes(kind)) return kind
  }
  return undefined
}

/**
 * Picks the tool for a block. When the block only drops with certain tools, only those count;
 * otherwise the best tool of the right kind does. Pure, so the rules are easy to test.
 */
export function chooseTool(input: ToolChoiceInput): ToolChoice {
  const kind = preferredKind(input.material)
  const pool =
    input.harvestTools.length > 0
      ? input.carried.filter((name) => input.harvestTools.includes(name))
      : input.carried.filter((name) => kind !== undefined && name.endsWith(`_${kind}`))
  const best = [...pool].sort((a, b) => speedRank(a) - speedRank(b) || a.localeCompare(b))[0]
  return { canHarvest: input.harvestTools.length === 0 || best !== undefined, tool: best }
}
