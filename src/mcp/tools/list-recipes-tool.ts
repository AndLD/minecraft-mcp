import { z } from 'zod'
import { countItems, describeItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Recipe, RecipeBook } from '../../core/recipes.port.js'
import type { RecipePlanner } from '../../skills/crafting/recipe-planner.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'

const MAX_RECIPES_SHOWN = 6
const MAX_LISTED_ITEMS = 60

const schema = z.object({
  item: z
    .string()
    .min(1)
    .optional()
    .describe('Show the recipes for this exact item name, and whether the bot can craft it now.'),
  search: z
    .string()
    .min(1)
    .optional()
    .describe('List craftable items whose name contains this text, for example "pickaxe".'),
  craftable_now: z
    .boolean()
    .default(false)
    .describe('List what the bot can craft right now from its inventory in one step.'),
})

const describeRecipe = (recipe: Recipe): Record<string, unknown> => ({
  makes: recipe.result.count,
  needs: describeItems(recipe.ingredients),
  needsCraftingTable: recipe.needsTable,
})

export class ListRecipesTool implements ToolDefinition<typeof schema> {
  readonly name = 'list_recipes'
  readonly description =
    'Looks up crafting recipes. With "item": the recipes for it (several variants exist for wooden items: any wood type works), ' +
    'and whether the bot can craft it now, with the steps or what is missing. With "search": craftable item names containing the ' +
    'text. With "craftable_now": what the inventory allows in one step. Give exactly one of them. Read-only.'
  readonly inputSchema = schema

  constructor(
    private readonly book: RecipeBook,
    private readonly planner: RecipePlanner,
    private readonly inventory: InventoryReader,
  ) {}

  execute(input: z.output<typeof schema>) {
    const forms = [input.item !== undefined, input.search !== undefined, input.craftable_now]
    if (forms.filter(Boolean).length !== 1)
      return toolFail('Give exactly one of: item, search, craftable_now.')
    const snapshot = this.inventory.snapshot()
    if (snapshot === undefined) return toolFail('Not connected to a Minecraft world.')
    const counts = countItems(snapshot)

    if (input.item !== undefined) {
      const recipes = this.book.recipesFor(input.item)
      if (recipes.length === 0)
        return toolFail(
          this.book.isItem(input.item)
            ? `${input.item} has no crafting recipe. It may need smelting, or has to be found or gathered.`
            : `"${input.item}" is not an item name.`,
        )
      const plan = this.planner.plan([{ name: input.item, count: 1 }], counts)
      return toolOk({
        item: input.item,
        recipes: recipes.slice(0, MAX_RECIPES_SHOWN).map(describeRecipe),
        totalRecipes: recipes.length,
        canCraftNow: plan.missing.length === 0,
        steps: plan.steps.map((step) => `${step.item} x${String(step.times)}`),
        missing: plan.missing,
        needsCraftingTable: plan.needsTable,
      })
    }

    if (input.search !== undefined) {
      const needle = input.search.toLowerCase()
      const names = this.book
        .craftableItems()
        .filter((name) => name.includes(needle))
        .sort()
      return toolOk({ count: names.length, items: names.slice(0, MAX_LISTED_ITEMS) })
    }

    const now = this.planner
      .craftableNow(counts)
      .map(({ item, recipe }) => ({ item, ...describeRecipe(recipe) }))
      .sort((a, b) => a.item.localeCompare(b.item))
    return toolOk({ count: now.length, items: now.slice(0, MAX_LISTED_ITEMS) })
  }
}
