export interface CropSpec {
  /** The item planted to grow this crop. */
  readonly seed: string
  /** The block's `age` property once fully grown. */
  readonly maxAge: number
}

export const CROP_NAMES = ['wheat', 'carrots', 'potatoes', 'beetroots'] as const
export type CropName = (typeof CROP_NAMES)[number]

const CROPS: Readonly<Record<CropName, CropSpec>> = {
  wheat: { seed: 'wheat_seeds', maxAge: 7 },
  carrots: { seed: 'carrot', maxAge: 7 },
  potatoes: { seed: 'potato', maxAge: 7 },
  beetroots: { seed: 'beetroot_seeds', maxAge: 3 },
}

/** The crop's own spec by its block name (`wheat`, `carrots`, ...), or undefined for anything else. */
export function classifyCrop(blockName: string): CropSpec | undefined {
  return (CROPS as Record<string, CropSpec>)[blockName]
}

/** The crop block name and spec for either the crop's own name or its seed item (`wheat_seeds` -> `wheat`). */
export function cropFor(nameOrSeed: string): { readonly block: CropName; readonly spec: CropSpec } | undefined {
  for (const name of CROP_NAMES) {
    const spec = CROPS[name]
    if (name === nameOrSeed || spec.seed === nameOrSeed) return { block: name, spec }
  }
  return undefined
}
