import type { AnimalInfo } from '../../core/animal-scanner.port.js'
import { individualProtection } from '../hunting/animal-catalog.js'

/** Why an animal is left alone when its wool or milk is taken. */
export type ProductSkip =
  | 'named'
  | 'tamed'
  | 'saddled'
  | 'ridden'
  | 'baby'
  | 'sheared'
  | 'colour'
  | 'no_effect'
  | 'unreachable'

/**
 * The rules that keep an animal out of a shearing or milking run: somebody's pet or mount, a baby (no wool or milk
 * yet), and for sheep one that was sheared already. Mooshrooms count as cows; `individualProtection` only knows
 * livestock, so the species is mapped before it is asked.
 */
export function productSkip(animal: AnimalInfo): ProductSkip | undefined {
  if (animal.baby) return 'baby'
  const species = animal.species === 'mooshroom' ? 'cow' : animal.species
  const reason = individualProtection({ ...animal, species }, false)
  if (reason === 'named' || reason === 'tamed' || reason === 'saddled' || reason === 'ridden')
    return reason
  if (animal.species === 'sheep' && animal.sheared === true) return 'sheared'
  return undefined
}

/** Counts of the animals that were passed over, by reason. */
export type Skipped = Partial<Record<ProductSkip, number>>

export function tally(skipped: Skipped, reason: ProductSkip): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1
}
