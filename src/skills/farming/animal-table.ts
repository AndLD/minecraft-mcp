/** Species that can be lured, penned, and bred, and the item that attracts and breeds each one. */
export const BREED_FOOD: Readonly<Record<string, string>> = {
  cow: 'wheat',
  mooshroom: 'wheat',
  sheep: 'wheat',
  pig: 'carrot',
  chicken: 'wheat_seeds',
  rabbit: 'carrot',
}

export const PENNABLE_SPECIES = Object.keys(BREED_FOOD)

/** The item that attracts and breeds a species, or undefined for anything else. */
export function foodFor(species: string): string | undefined {
  return BREED_FOOD[species]
}
