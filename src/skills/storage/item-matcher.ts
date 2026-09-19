import type { ItemFacts } from '../../core/item-facts.port.js'

type Predicate = (name: string, facts: ItemFacts) => boolean

const TOOL_OR_WEAPON =
  /_(pickaxe|axe|shovel|hoe|sword)$|^(shears|fishing_rod|bow|crossbow|trident|flint_and_steel|mace)$/
const ARMOR = /_(helmet|chestplate|leggings|boots)$|^(elytra|shield|turtle_helmet)$/
const STONES = new Set([
  'stone',
  'cobblestone',
  'deepslate',
  'cobbled_deepslate',
  'granite',
  'diorite',
  'andesite',
  'tuff',
  'blackstone',
])

/**
 * Item groups a rule can name instead of listing every item ("logs", "ores", "food", ...). Adding a group means
 * adding a line here.
 */
const GROUPS: Readonly<Record<string, Predicate>> = {
  '*': () => true,
  logs: (name) => /_(log|stem)$/.test(name) && !name.startsWith('stripped_'),
  planks: (name) => name.endsWith('_planks'),
  wood: (name) => /_(log|stem|planks|wood|hyphae)$/.test(name),
  stone: (name) => STONES.has(name),
  ores: (name) =>
    /_ore$/.test(name) ||
    name.startsWith('raw_') ||
    ['coal', 'diamond', 'emerald', 'lapis_lazuli', 'redstone', 'ancient_debris'].includes(name),
  ingots: (name) =>
    name.endsWith('_ingot') || name.endsWith('_nugget') || name === 'netherite_scrap',
  food: (name, facts) => facts.isFood(name),
  tools: (name) => TOOL_OR_WEAPON.test(name),
  armor: (name) => ARMOR.test(name),
  blocks: (name, facts) => facts.isBlock(name) && !TOOL_OR_WEAPON.test(name),
  wool: (name) => name.endsWith('_wool'),
  dyes: (name) => name.endsWith('_dye'),
}

export const ITEM_GROUP_NAMES = Object.keys(GROUPS)

/** True when the spec is a group name rather than an item name. */
export const isGroup = (spec: string): boolean => spec in GROUPS

/** A spec is a group name (`logs`) or an exact item name (`cobblestone`). */
export function matchesSpec(spec: string, item: string, facts: ItemFacts): boolean {
  const group = GROUPS[spec]
  return group === undefined ? spec === item : group(item, facts)
}

export function matchesAny(specs: readonly string[], item: string, facts: ItemFacts): boolean {
  return specs.some((spec) => matchesSpec(spec, item, facts))
}

/** Specs that name neither a group nor a known item. */
export function unknownSpecs(specs: readonly string[], facts: ItemFacts): string[] {
  return specs.filter((spec) => !isGroup(spec) && !facts.isItem(spec))
}

const TORCHES = /^(soul_)?torch$/
const BUCKETS = /_bucket$/

/**
 * Items the bot keeps for itself: tools, weapons, armor, food, torches, and buckets. They are never deposited
 * unless asked for by exact name (or with `include_reserved`).
 */
export function isReserved(item: string, facts: ItemFacts): boolean {
  return (
    TOOL_OR_WEAPON.test(item) ||
    ARMOR.test(item) ||
    facts.isFood(item) ||
    TORCHES.test(item) ||
    BUCKETS.test(item)
  )
}
