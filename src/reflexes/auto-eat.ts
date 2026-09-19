import type { Eater, FoodCatalog } from '../core/food.port.js'
import type { InventoryReader } from '../core/inventory.port.js'
import { chooseFood } from './food-choice.js'
import type { Reflex, ReflexContext, ReflexOutcome, ReflexState } from './reflex.types.js'

/** Eat when the food bar is at this level or lower. */
export const EAT_AT_OR_BELOW = 14
/** Also eat when hurt and not quite full, so health can regenerate (it needs food of 18 or more). */
const HEAL_FOOD_LEVEL = 17
const HURT_HEALTH = 14
const NO_FOOD_WARNING_INTERVAL_MS = 5 * 60_000
const FAILURE_PAUSE_MS = 10_000

export interface AutoEatOptions {
  readonly inventory: InventoryReader
  readonly catalog: FoodCatalog
  readonly eater: Eater
  /** Called when the bot is hungry and has nothing to eat (at most every few minutes). */
  readonly onNoFood?: () => void
}

/** Keeps the food bar up with the best food in the inventory, without stopping the current task. */
export class AutoEat implements Reflex {
  readonly name = 'auto_eat'
  readonly priority = 20
  readonly preemptsTask = false
  private lastNoFoodWarningAt = Number.NEGATIVE_INFINITY
  private pausedUntil = Number.NEGATIVE_INFINITY

  constructor(private readonly options: AutoEatOptions) {}

  wants(state: ReflexState): boolean {
    if (!this.isHungry(state) || state.now < this.pausedUntil) return false
    if (this.foodToEat() !== undefined) return true
    return state.now - this.lastNoFoodWarningAt >= NO_FOOD_WARNING_INTERVAL_MS // wants once, to say so
  }

  async run(context: ReflexContext, state: ReflexState): Promise<ReflexOutcome> {
    const food = this.foodToEat()
    if (food === undefined) {
      this.lastNoFoodWarningAt = state.now
      context.emit(
        `Hungry (food ${String(state.vitals.food)}/20) but there is nothing safe to eat.`,
      )
      this.options.onNoFood?.()
      return { resumeTask: true }
    }
    const result = await this.options.eater.eat(food)
    if (result.ok) {
      const now = context.state()?.vitals.food
      context.emit(
        `Ate ${food} (food ${String(state.vitals.food)} → ${now === undefined ? '?' : String(now)}).`,
      )
    } else {
      this.pausedUntil = state.now + FAILURE_PAUSE_MS
      context.emit(result.error)
    }
    return { resumeTask: true }
  }

  private isHungry(state: ReflexState): boolean {
    const { food, health } = state.vitals
    return food <= EAT_AT_OR_BELOW || (health <= HURT_HEALTH && food <= HEAL_FOOD_LEVEL)
  }

  private foodToEat(): string | undefined {
    const snapshot = this.options.inventory.snapshot()
    return snapshot === undefined ? undefined : chooseFood(snapshot.stacks, this.options.catalog)
  }
}
