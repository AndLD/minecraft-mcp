import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { CraftFailure, Crafter, ItemCount, Recipe, RecipeBook } from '../core/recipes.port.js'
import type { BotHolder, BotLike, RecipeLike } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

const fail = (reason: CraftFailure['reason'], message: string): Result<never, CraftFailure> =>
  err({ reason, message })

/** Recipes and crafting over Mineflayer. A recipe is identified by its position in `recipesAll`, which is stable. */
export class MineflayerRecipes implements RecipeBook, Crafter {
  constructor(private readonly holder: BotHolder) {}

  recipesFor(item: string): readonly Recipe[] {
    const bot = this.holder.current()
    const id = bot?.registry.itemsByName[item]?.id
    if (bot === undefined || id === undefined) return []
    return bot.recipesAll(id, null, true).map((recipe, index) => toRecipe(bot, recipe, index))
  }

  craftableItems(): readonly string[] {
    const bot = this.holder.current()
    if (bot === undefined) return []
    return Object.keys(bot.registry.recipes)
      .map((id) => bot.registry.items[Number(id)]?.name)
      .filter((name): name is string => name !== undefined)
  }

  isItem(name: string): boolean {
    return this.holder.current()?.registry.itemsByName[name] !== undefined
  }

  async craft(
    item: string,
    recipeIndex: number,
    times: number,
    table: Position | undefined,
  ): Promise<Result<void, CraftFailure>> {
    const bot = this.holder.current()
    if (bot === undefined) return fail('not_connected', 'Not connected to a Minecraft world.')
    const id = bot.registry.itemsByName[item]?.id
    const recipe = id === undefined ? undefined : bot.recipesAll(id, null, true)[recipeIndex]
    if (recipe === undefined)
      return fail('unknown_recipe', `There is no recipe ${String(recipeIndex)} for ${item}.`)

    const block = table === undefined ? null : bot.blockAt(toVec3(table))
    if (recipe.requiresTable && (block === null || block.name !== 'crafting_table'))
      return fail('table_missing', 'That recipe needs a crafting table within reach.')
    try {
      await bot.craft(recipe, times, block)
      return ok(undefined)
    } catch (error) {
      return fail('failed', error instanceof Error ? error.message : String(error))
    }
  }
}

function toRecipe(bot: BotLike, recipe: RecipeLike, index: number): Recipe {
  const name = (id: number): string => bot.registry.items[id]?.name ?? `item_${String(id)}`
  const ingredients: ItemCount[] = recipe.delta
    .filter((entry) => entry.count < 0)
    .map((entry) => ({ name: name(entry.id), count: -entry.count }))
  return {
    result: { name: name(recipe.result.id), count: recipe.result.count },
    ingredients,
    needsTable: recipe.requiresTable,
    index,
  }
}
