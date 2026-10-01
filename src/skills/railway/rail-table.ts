export const RAIL = 'rail'
export const POWERED_RAIL = 'powered_rail'
export const POWER_TORCH = 'redstone_torch'
export const MINECART = 'minecart'

export const isRailName = (name: string | undefined): boolean =>
  name === RAIL || name === POWERED_RAIL

/** Power passes from a powered rail to the next one in line up to this many rails away. */
export const POWER_REACH = 8
/** In the rich variant a torch is set every this many powered rails in a run (a margin under the reach). */
export const RICH_TORCH_SPACING = 9
export const ECONOMY_SPACING_DEFAULT = 8
export const ECONOMY_SPACING_MIN = 7
export const ECONOMY_SPACING_MAX = 10
/** The first this many rails of a line are powered, so a cart resting on the first one gets up to speed. */
export const START_RUN = 4
/** On a slope a cart slows fast, so a powered rail is set this often. */
export const SLOPE_SPACING = 3

/** What one craft makes: rails 16 from 6 iron ingots and a stick, and so on. */
const RECIPES: Readonly<
  Record<string, { readonly yields: number; readonly needs: Readonly<Record<string, number>> }>
> = {
  [RAIL]: { yields: 16, needs: { iron_ingot: 6, stick: 1 } },
  [POWERED_RAIL]: { yields: 6, needs: { gold_ingot: 6, stick: 1, redstone: 1 } },
  [POWER_TORCH]: { yields: 1, needs: { redstone: 1, stick: 1 } },
  [MINECART]: { yields: 1, needs: { iron_ingot: 5 } },
}

export interface ItemAmount {
  readonly name: string
  readonly count: number
}

/**
 * The raw materials to craft what is missing (`rail`, `powered_rail`, `redstone_torch`, `minecart`; other items
 * are left out, they are gathered rather than crafted), by whole crafts: 20 rails take two crafts, so 12 iron ingots.
 */
export function rawMaterialsFor(missing: readonly ItemAmount[]): ItemAmount[] {
  const totals = new Map<string, number>()
  for (const item of missing) {
    const recipe = RECIPES[item.name]
    if (recipe === undefined || item.count <= 0) continue
    const crafts = Math.ceil(item.count / recipe.yields)
    for (const [name, count] of Object.entries(recipe.needs))
      totals.set(name, (totals.get(name) ?? 0) + count * crafts)
  }
  return [...totals]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
