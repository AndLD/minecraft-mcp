import type { ItemCount, Recipe, RecipeBook } from '../../core/recipes.port.js'

export interface CraftStep {
  readonly item: string
  /** How many times the recipe is crafted. */
  readonly times: number
  readonly recipe: Recipe
}

export interface CraftPlan {
  /** In the order to run them: ingredients before what they make. */
  readonly steps: readonly CraftStep[]
  /** Raw materials that are still needed. Empty when the plan can be carried out. */
  readonly missing: readonly ItemCount[]
  readonly needsTable: boolean
}

/** Wood types tried first, so a plan for a wooden tool with no materials asks for oak, not cherry. */
const PREFERRED_MATERIALS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak']
/** Stops a runaway search in odd recipe graphs; a normal plan visits a few dozen nodes. */
const NODE_LIMIT = 5000

interface Budget {
  left: number
}

class Stock {
  constructor(
    readonly have: Map<string, number>,
    readonly steps: CraftStep[] = [],
  ) {}

  clone(): Stock {
    return new Stock(new Map(this.have), [...this.steps])
  }

  amount(item: string): number {
    return this.have.get(item) ?? 0
  }

  /** Uses up to `wanted` from stock and returns how many were used. */
  take(item: string, wanted: number): number {
    const used = Math.min(this.amount(item), wanted)
    this.have.set(item, this.amount(item) - used)
    return used
  }

  add(item: string, count: number): void {
    this.have.set(item, this.amount(item) + count)
  }

  adopt(other: Stock): void {
    this.have.clear()
    for (const [item, count] of other.have) this.have.set(item, count)
    this.steps.length = 0
    this.steps.push(...other.steps)
  }
}

/**
 * Works out which recipes to craft, in which order, to make items from what is in the inventory, including the
 * intermediate crafts (logs to planks to sticks). Pure: it only reads recipes through `RecipeBook`.
 *
 * Minecraft has one recipe per wood type for most wooden items, so every step tries only the variants whose
 * ingredients can actually be had, best first, and backtracks when the quantities do not add up.
 */
export class RecipePlanner {
  constructor(private readonly book: RecipeBook) {}

  /**
   * Plans the goals one after another on the same inventory. Each goal makes `count` more of the item,
   * even when some are already carried.
   */
  plan(goals: readonly ItemCount[], inventory: ReadonlyMap<string, number>): CraftPlan {
    const search = new Search(this.book, inventory)
    const stock = new Stock(new Map(inventory))
    const missing = new Map<string, number>()
    for (const goal of goals) {
      const trial = stock.clone()
      if (search.make(trial, goal.name, goal.count, [], { left: NODE_LIMIT }, true))
        stock.adopt(trial)
      else search.shortfall(stock.clone(), goal.name, goal.count, [], missing, true)
    }
    return {
      steps: mergeNeighbours(stock.steps),
      missing: [...missing].map(([name, count]) => ({ name, count })),
      needsTable: stock.steps.some((step) => step.recipe.needsTable),
    }
  }

  /** Items one recipe away: every ingredient is carried in the needed amount. */
  craftableNow(
    inventory: ReadonlyMap<string, number>,
  ): readonly { item: string; recipe: Recipe }[] {
    const result: { item: string; recipe: Recipe }[] = []
    for (const item of this.book.craftableItems()) {
      const recipe = this.book
        .recipesFor(item)
        .find((candidate) =>
          candidate.ingredients.every((ing) => (inventory.get(ing.name) ?? 0) >= ing.count),
        )
      if (recipe !== undefined) result.push({ item, recipe })
    }
    return result
  }
}

/** One planning run: caches recipe lookups and which items can be had at all. */
class Search {
  private readonly recipeCache = new Map<string, readonly Recipe[]>()
  private readonly obtainable = new Map<string, boolean>()

  constructor(
    private readonly book: RecipeBook,
    private readonly initial: ReadonlyMap<string, number>,
  ) {}

  /** Adds the steps that make `need` of the item to the stock's plan. False when the stock cannot cover it. */
  make(
    stock: Stock,
    item: string,
    need: number,
    stack: readonly string[],
    budget: Budget,
    forceCraft: boolean,
  ): boolean {
    budget.left -= 1
    if (budget.left < 0) return false
    const remaining = forceCraft ? need : need - stock.take(item, need)
    if (remaining === 0) return true
    if (stack.includes(item)) return false

    for (const recipe of this.rank(this.recipes(item), stock).filter((r) => this.feasible(r))) {
      const trial = stock.clone()
      const times = Math.ceil(remaining / recipe.result.count)
      const made = recipe.ingredients.every((ingredient) =>
        this.make(
          trial,
          ingredient.name,
          ingredient.count * times,
          [...stack, item],
          budget,
          false,
        ),
      )
      if (!made) continue
      trial.add(item, times * recipe.result.count - remaining)
      trial.steps.push({ item, times, recipe })
      stock.adopt(trial)
      return true
    }
    return false
  }

  /** Follows the best-looking recipe all the way down and records the raw materials that are lacking. */
  shortfall(
    stock: Stock,
    item: string,
    need: number,
    stack: readonly string[],
    missing: Map<string, number>,
    forceCraft: boolean,
  ): void {
    const remaining = forceCraft ? need : need - stock.take(item, need)
    if (remaining === 0) return
    const recipe = stack.includes(item) ? undefined : this.rank(this.recipes(item), stock)[0]
    if (recipe === undefined) {
      missing.set(item, (missing.get(item) ?? 0) + remaining)
      return
    }
    const times = Math.ceil(remaining / recipe.result.count)
    for (const ingredient of recipe.ingredients)
      this.shortfall(
        stock,
        ingredient.name,
        ingredient.count * times,
        [...stack, item],
        missing,
        false,
      )
    stock.add(item, times * recipe.result.count - remaining)
  }

  private recipes(item: string): readonly Recipe[] {
    const cached = this.recipeCache.get(item)
    if (cached !== undefined) return cached
    const recipes = this.book.recipesFor(item)
    this.recipeCache.set(item, recipes)
    return recipes
  }

  /** Recipes whose ingredients are all carried, or can be crafted from what is carried (ignoring quantities). */
  private feasible(recipe: Recipe): boolean {
    return recipe.ingredients.every((ingredient) => this.canObtain(ingredient.name))
  }

  private canObtain(item: string): boolean {
    const known = this.obtainable.get(item)
    if (known !== undefined) return known
    if ((this.initial.get(item) ?? 0) > 0) return true
    this.obtainable.set(item, false) // while being worked out, so recipe cycles end
    const result = this.recipes(item).some((recipe) => this.feasible(recipe))
    this.obtainable.set(item, result)
    return result
  }

  /** Recipes using more of what is already carried come first, then the usual wood types. */
  private rank(recipes: readonly Recipe[], stock: Stock): readonly Recipe[] {
    const carried = (recipe: Recipe): number =>
      recipe.ingredients.filter((ingredient) => stock.amount(ingredient.name) > 0).length
    return [...recipes].sort(
      (a, b) => carried(b) - carried(a) || materialRank(a) - materialRank(b) || a.index - b.index,
    )
  }
}

/** Two crafts of the same recipe in a row become one craft run twice. */
function mergeNeighbours(steps: readonly CraftStep[]): CraftStep[] {
  const merged: CraftStep[] = []
  for (const step of steps) {
    const last = merged.at(-1)
    if (last?.item === step.item && last.recipe.index === step.recipe.index)
      merged[merged.length - 1] = { ...last, times: last.times + step.times }
    else merged.push(step)
  }
  return merged
}

function materialRank(recipe: Recipe): number {
  const ranks = recipe.ingredients.map((ingredient) => {
    const index = PREFERRED_MATERIALS.findIndex((material) =>
      ingredient.name.startsWith(`${material}_`),
    )
    return index === -1 ? PREFERRED_MATERIALS.length : index
  })
  return Math.min(...ranks, PREFERRED_MATERIALS.length)
}
