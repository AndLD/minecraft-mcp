import type { FoodCatalog } from '../core/food.port.js'
import type { ItemStackInfo } from '../core/inventory.port.js'

/** Food worth keeping, or harmful: never eaten automatically. */
export const AVOIDED_FOOD: ReadonlySet<string> = new Set([
  'rotten_flesh',
  'spider_eye',
  'poisonous_potato',
  'pufferfish',
  'chicken', // raw chicken can give food poisoning
  'suspicious_stew',
  'chorus_fruit', // teleports the bot somewhere random
  'golden_apple',
  'enchanted_golden_apple',
  'golden_carrot',
])

/** The best food to eat: the most hunger points restored, then the most saturation. */
export function chooseFood(
  stacks: readonly ItemStackInfo[],
  catalog: FoodCatalog,
): string | undefined {
  const foods = stacks
    .filter((stack) => !AVOIDED_FOOD.has(stack.name))
    .map((stack) => catalog.info(stack.name))
    .filter((info): info is NonNullable<typeof info> => info !== undefined)
    .sort((a, b) => b.foodPoints - a.foodPoints || b.saturation - a.saturation)
  return foods[0]?.name
}
