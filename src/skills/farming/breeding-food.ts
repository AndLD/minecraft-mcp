import type { AnimalInteraction } from '../../core/animal-interaction.port.js'
import { foodsFor } from './animal-table.js'

/** Takes the first breeding food of the species that the bot carries in hand; undefined when it has none. */
export async function holdBreedingFood(
  interaction: AnimalInteraction,
  species: string,
): Promise<string | undefined> {
  for (const food of foodsFor(species)) {
    const held = await interaction.hold(food)
    if (held.ok) return food
  }
  return undefined
}
