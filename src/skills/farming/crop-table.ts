export interface CropSpec {
  /** The item planted to grow this crop. */
  readonly seed: string
  /** The block's `age` property once fully grown. */
  readonly maxAge: number
  /**
   * `plain`: the crop itself is harvested in place and replanted (wheat). `stem`: the seed grows a stem that stays
   * for good, and the fruit (`fruit`) grows on a free cell beside it and is the block to harvest (pumpkin).
   */
  readonly kind: 'plain' | 'stem'
  /** A stem crop: the stem block's name (`pumpkin_stem`), and the fruit block the stem grows. */
  readonly stem?: string
  readonly fruit?: string
}

export const CROP_NAMES = ['wheat', 'carrots', 'potatoes', 'beetroots', 'pumpkin'] as const
export type CropName = (typeof CROP_NAMES)[number]

const CROPS: Readonly<Record<CropName, CropSpec>> = {
  wheat: { seed: 'wheat_seeds', maxAge: 7, kind: 'plain' },
  carrots: { seed: 'carrot', maxAge: 7, kind: 'plain' },
  potatoes: { seed: 'potato', maxAge: 7, kind: 'plain' },
  beetroots: { seed: 'beetroot_seeds', maxAge: 3, kind: 'plain' },
  pumpkin: {
    seed: 'pumpkin_seeds',
    maxAge: 7,
    kind: 'stem',
    stem: 'pumpkin_stem',
    fruit: 'pumpkin',
  },
}

/**
 * The crop's own spec by its block name (`wheat`, `carrots`, ..., or a stem: `pumpkin_stem`), or undefined for
 * anything else. A stem that has grown its fruit turns into `attached_pumpkin_stem`, which has no age and is still
 * the same stem.
 */
export function classifyCrop(blockName: string): CropSpec | undefined {
  const plain = (CROPS as Record<string, CropSpec>)[blockName]
  if (plain !== undefined && plain.kind === 'plain') return plain
  const bare = blockName.replace(/^attached_/, '')
  return CROP_NAMES.map((name) => CROPS[name]).find(
    (spec) => spec.kind === 'stem' && spec.stem === bare,
  )
}

/** The stem crop whose fruit block is this (`pumpkin`), or undefined. */
export function stemCropOfFruit(blockName: string): CropSpec | undefined {
  return CROP_NAMES.map((name) => CROPS[name]).find(
    (spec) => spec.kind === 'stem' && spec.fruit === blockName,
  )
}

/** The crop block name and spec for either the crop's own name or its seed item (`wheat_seeds` -> `wheat`). */
export function cropFor(
  nameOrSeed: string,
): { readonly block: CropName; readonly spec: CropSpec } | undefined {
  for (const name of CROP_NAMES) {
    const spec = CROPS[name]
    if (name === nameOrSeed || spec.seed === nameOrSeed) return { block: name, spec }
  }
  return undefined
}

/** The name a crop is registered and planted under for a block seen in a field: `pumpkin_stem` -> `pumpkin`. */
export function cropNameOfBlock(blockName: string): string | undefined {
  const spec = classifyCrop(blockName)
  if (spec === undefined) return undefined
  return CROP_NAMES.find((name) => CROPS[name] === spec)
}
