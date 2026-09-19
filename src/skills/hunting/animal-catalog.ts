import type { AnimalInfo } from '../../core/animal-scanner.port.js'
import type { Position } from '../../core/position.types.js'

/** Livestock the bot may hunt, and what each drops. Everything else (villagers, pets, horses, bees, ...) is never hunted. */
export const HUNTABLE_SPECIES: Readonly<Record<string, { readonly drops: readonly string[] }>> = {
  cow: { drops: ['beef', 'leather'] },
  mooshroom: { drops: ['beef', 'leather'] },
  pig: { drops: ['porkchop'] },
  sheep: { drops: ['mutton', 'wool'] },
  chicken: { drops: ['chicken', 'feather'] },
  rabbit: { drops: ['rabbit', 'rabbit_hide', 'rabbit_foot'] },
}

/** Raw meat and what it cooks into. */
export const COOKED_MEAT: Readonly<Record<string, string>> = {
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  mutton: 'cooked_mutton',
  chicken: 'cooked_chicken',
  rabbit: 'cooked_rabbit',
}

/** Adults of a species that are never hunted, so the herd can breed again. */
export const BREEDING_FLOOR = 2

export const HUNTABLE_SPECIES_NAMES = Object.keys(HUNTABLE_SPECIES)

/** True when a dropped item counts as the wanted one (`wool` stands for any colour). */
export function itemMatches(wanted: string, dropped: string): boolean {
  return wanted === 'wool' ? dropped.endsWith('_wool') : dropped === wanted
}

/** What a hunt for an item means: the raw item to collect, whether it must be cooked, and who drops it. */
export interface ItemGoal {
  readonly raw: string
  readonly cooked: string | undefined
  readonly species: readonly string[]
}

/** Resolves "beef", "cooked_beef", "leather", "wool" ... to species; undefined when no huntable animal drops it. */
export function goalForItem(item: string): ItemGoal | undefined {
  const rawOfCooked = Object.entries(COOKED_MEAT).find(([, cooked]) => cooked === item)?.[0]
  const raw = rawOfCooked ?? item
  const species = HUNTABLE_SPECIES_NAMES.filter((name) =>
    HUNTABLE_SPECIES[name]?.drops.includes(raw),
  )
  if (species.length === 0) return undefined
  return { raw, cooked: rawOfCooked === undefined ? undefined : item, species }
}

export type Protection =
  'not_huntable' | 'named' | 'tamed' | 'saddled' | 'ridden' | 'baby' | 'penned' | 'breeding_pair'

export const PROTECTION_TEXT: Readonly<Record<Protection, string>> = {
  not_huntable: 'not livestock',
  named: 'has a name tag',
  tamed: 'is tamed',
  saddled: 'is saddled',
  ridden: 'is being ridden',
  baby: 'is a baby',
  penned: 'is in a pen',
  breeding_pair: 'is one of the last breeding pair',
}

export interface SelectionOptions {
  /** Species wanted. Others are not considered at all. */
  readonly species: readonly string[]
  readonly keepBreeders: boolean
  readonly allowBabies: boolean
  readonly includePens: boolean
  /** Animals to leave out (could not be reached). */
  readonly skip: ReadonlySet<number>
  isPenned(position: Position): boolean
}

export interface Assessed {
  readonly animal: AnimalInfo
  /** Why the animal must not be hunted; undefined when it may be. */
  readonly protection: Protection | undefined
}

/** The rules that depend only on the animal itself. */
export function individualProtection(
  animal: AnimalInfo,
  allowBabies: boolean,
): Protection | undefined {
  // The specific reasons come first: "is tamed" says more than "not livestock".
  if (animal.named) return 'named'
  if (animal.owned) return 'tamed'
  if (animal.saddled) return 'saddled'
  if (animal.ridden) return 'ridden'
  if (!(animal.species in HUNTABLE_SPECIES)) return 'not_huntable'
  if (animal.baby && !allowBabies) return 'baby'
  return undefined
}

/**
 * Applies every protection rule to the animals of the wanted species, nearest first (the input order).
 * The breeding floor looks at all adults of the species in view, protected or not.
 */
export function assessAnimals(
  animals: readonly AnimalInfo[],
  options: SelectionOptions,
): Assessed[] {
  const adults = new Map<string, number>()
  for (const animal of animals)
    if (!animal.baby) adults.set(animal.species, (adults.get(animal.species) ?? 0) + 1)

  return animals
    .filter((animal) => options.species.includes(animal.species) && !options.skip.has(animal.id))
    .map((animal) => {
      let protection = individualProtection(animal, options.allowBabies)
      if (protection === undefined && !options.includePens && options.isPenned(animal.position))
        protection = 'penned'
      if (
        protection === undefined &&
        options.keepBreeders &&
        !animal.baby &&
        (adults.get(animal.species) ?? 0) <= BREEDING_FLOOR
      )
        protection = 'breeding_pair'
      return { animal, protection }
    })
}

/** The nearest animal that may be hunted, and how many were passed over for each reason. */
export function selectTarget(
  animals: readonly AnimalInfo[],
  options: SelectionOptions,
): { target: AnimalInfo | undefined; passedOver: Partial<Record<Protection, number>> } {
  const assessed = assessAnimals(animals, options)
  const passedOver: Partial<Record<Protection, number>> = {}
  for (const { protection } of assessed)
    if (protection !== undefined) passedOver[protection] = (passedOver[protection] ?? 0) + 1
  return { target: assessed.find((entry) => entry.protection === undefined)?.animal, passedOver }
}
