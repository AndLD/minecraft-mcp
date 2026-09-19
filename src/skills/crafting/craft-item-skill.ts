import { countItems, describeItems, gained } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Position } from '../../core/position.types.js'
import type { Crafter, ItemCount, RecipeBook } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { CraftPlan, RecipePlanner } from './recipe-planner.js'
import type { Workstations } from './workstations.js'

const TABLE = 'crafting_table'
const MAX_SUGGESTIONS = 8

export interface CraftInput {
  readonly item: string
  /** How many more to make (a recipe may make several per craft, so a little extra is possible). */
  readonly count: number
}

export interface CraftOutput {
  readonly item: string
  /** How many of the item the inventory gained. */
  readonly produced: number
  /** Everything crafted on the way, including intermediate items. */
  readonly steps: readonly { readonly item: string; readonly times: number }[]
  /** The crafting table was placed by the bot (it stays where it is). */
  readonly placedTable: boolean
}

export interface ItemCrafter {
  run(input: CraftInput, context: SkillContext): Promise<SkillResult<CraftOutput>>
}

export interface CraftItemDeps {
  readonly book: RecipeBook
  readonly planner: RecipePlanner
  readonly crafter: Crafter
  readonly inventory: InventoryReader
  readonly workstations: Workstations
}

/** Crafts an item, making the intermediate items on the way (logs to planks to sticks) and using or placing a crafting table when the recipe needs one. */
export class CraftItemSkill implements Skill<CraftInput, CraftOutput>, ItemCrafter {
  readonly name = 'craft'

  constructor(private readonly deps: CraftItemDeps) {}

  async run(input: CraftInput, context: SkillContext): Promise<SkillResult<CraftOutput>> {
    const { deps } = this
    if (!deps.book.isItem(input.item)) return err(this.unknownItem(input.item))
    if (deps.book.recipesFor(input.item).length === 0)
      return err({
        reason: 'no_recipe',
        message: `${input.item} cannot be crafted. It may need smelting, or has to be found or gathered.`,
      })

    const before = countItems(deps.inventory.snapshot())
    let plan = deps.planner.plan([{ name: input.item, count: input.count }], before)
    if (plan.missing.length > 0) return err(this.missing(input, plan.missing))

    if (plan.needsTable && !deps.workstations.available(TABLE)) {
      // No table anywhere: make one first (2x2 recipe), then craft the item on it.
      plan = deps.planner.plan(
        [
          { name: TABLE, count: 1 },
          { name: input.item, count: input.count },
        ],
        before,
      )
      if (plan.missing.length > 0)
        return err(this.missing(input, plan.missing, ' (it also needs a crafting table)'))
    }

    let table: Position | undefined
    let placedTable = false
    for (const step of plan.steps) {
      if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
      if (step.recipe.needsTable && table === undefined) {
        const standing = deps.workstations.standsNearby(TABLE)
        const ensured = await deps.workstations.ensure(TABLE, context)
        if (!ensured.ok) return ensured
        table = ensured.value
        placedTable = !standing
      }
      const crafted = await deps.crafter.craft(
        step.item,
        step.recipe.index,
        step.times,
        step.recipe.needsTable ? table : undefined,
      )
      if (!crafted.ok)
        return err({
          reason: 'craft_failed',
          message: `Crafting ${step.item} failed: ${crafted.error.message}`,
        })
      context.progress(`Crafted ${step.item} x${String(step.times)}`)
    }

    const produced = gained(before, countItems(deps.inventory.snapshot())).find(
      (entry) => entry.name === input.item,
    )
    return ok({
      item: input.item,
      produced: produced?.count ?? 0,
      steps: summarize(plan),
      placedTable,
    })
  }

  private unknownItem(item: string) {
    const similar = this.deps.book
      .craftableItems()
      .filter((name) => name.includes(item) || item.includes(name))
      .slice(0, MAX_SUGGESTIONS)
    return {
      reason: 'unknown_item',
      message:
        similar.length === 0
          ? `"${item}" is not an item name.`
          : `"${item}" is not an item name; did you mean: ${similar.join(', ')}?`,
    }
  }

  private missing(input: CraftInput, missing: readonly ItemCount[], suffix = '') {
    const wood = missing.some((entry) => /_(log|planks)$/.test(entry.name))
    return {
      reason: 'missing_materials',
      message:
        `Cannot craft ${String(input.count)} ${input.item}: missing ${describeItems(missing)}${suffix}.` +
        (wood ? ' Any wood type works for those.' : ''),
      detail: { missing },
    }
  }
}

function summarize(plan: CraftPlan): { item: string; times: number }[] {
  return plan.steps.map((step) => ({ item: step.item, times: step.times }))
}
