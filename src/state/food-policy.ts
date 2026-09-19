import { z } from 'zod'
import { err, ok, type Result } from '../core/result.js'
import type { StateStore } from '../core/state-store.port.js'
import { defineDocument } from './define-document.js'
import type { ProfileScoped } from './profile-scoped.types.js'

/** What the bot does when it is hungry and has nothing to eat. */
export type LowFoodPolicy = 'ask' | 'hunt_and_cook' | 'stop'

export const LOW_FOOD_POLICIES = ['ask', 'hunt_and_cook', 'stop'] as const

const foodPolicyDocument = defineDocument({
  key: 'food-policy',
  version: 1,
  schema: z.object({ policy: z.enum(LOW_FOOD_POLICIES) }),
  initial: (): { policy: LowFoodPolicy } => ({ policy: 'ask' }),
})

const NOT_ACTIVE =
  'No world is active, so the food policy cannot be saved. Connect to a world first.'

/** The player's standing rule for running out of food, saved per world. The default is to ask. */
export class FoodPolicy implements ProfileScoped {
  private store: StateStore | undefined
  private policy: LowFoodPolicy = 'ask'

  async attach(store: StateStore): Promise<readonly string[]> {
    const loaded = await store.load(foodPolicyDocument)
    this.store = store
    this.policy = loaded.value.policy
    return loaded.warning === undefined ? [] : [loaded.warning]
  }

  detach(): void {
    this.store = undefined
    this.policy = 'ask'
  }

  get(): LowFoodPolicy {
    return this.policy
  }

  set(policy: LowFoodPolicy): Result<void> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    this.policy = policy
    this.store.save(foodPolicyDocument, { policy })
    return ok(undefined)
  }
}
