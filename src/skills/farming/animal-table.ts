/** Species that can be lured and bred, and the item that attracts and breeds each one. */
export const BREED_FOOD: Readonly<Record<string, string>> = {
  cow: 'wheat',
  mooshroom: 'wheat',
  sheep: 'wheat',
  pig: 'carrot',
  chicken: 'wheat_seeds',
  rabbit: 'carrot',
  bee: 'poppy',
}

/** Other items that also attract and breed a species: a bee takes any flower. */
const ALSO_BREEDS_WITH: Readonly<Record<string, readonly string[]>> = {
  bee: [
    'dandelion',
    'blue_orchid',
    'allium',
    'azure_bluet',
    'red_tulip',
    'orange_tulip',
    'white_tulip',
    'pink_tulip',
    'oxeye_daisy',
    'cornflower',
    'lily_of_the_valley',
    'sunflower',
    'lilac',
    'rose_bush',
    'peony',
    'torchflower',
    'pitcher_plant',
    'wither_rose',
  ],
}

/** Species a player can lure and breed (the bee among them). */
export const BREEDABLE_SPECIES = Object.keys(BREED_FOOD)

/** Species that can be kept in a fenced pen: everything breedable that does not fly away (not the bee). */
export const PENNABLE_SPECIES = BREEDABLE_SPECIES.filter((species) => species !== 'bee')

/** The item that attracts and breeds a species, or undefined for anything else. */
export function foodFor(species: string): string | undefined {
  return BREED_FOOD[species]
}

/** Every item that attracts and breeds a species, the usual one first; empty for anything else. */
export function foodsFor(species: string): readonly string[] {
  const usual = BREED_FOOD[species]
  return usual === undefined ? [] : [usual, ...(ALSO_BREEDS_WITH[species] ?? [])]
}
