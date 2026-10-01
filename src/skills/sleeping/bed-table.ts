export const BED_COLOURS = [
  'white',
  'orange',
  'magenta',
  'light_blue',
  'yellow',
  'lime',
  'pink',
  'gray',
  'light_gray',
  'cyan',
  'purple',
  'blue',
  'brown',
  'green',
  'red',
  'black',
] as const

export const BED_NAMES: readonly string[] = BED_COLOURS.map((colour) => `${colour}_bed`)

export const isBedName = (name: string | undefined): boolean =>
  name !== undefined && name.endsWith('_bed') && BED_NAMES.includes(name)

export const colourOfBed = (name: string): string => name.replace(/_bed$/, '')

/** The night the game lets a player sleep through: from 12541 to 23458 ticks of the day. */
const NIGHT_START = 12_541
const NIGHT_END = 23_458

export const isNight = (timeOfDay: number): boolean =>
  timeOfDay >= NIGHT_START && timeOfDay <= NIGHT_END

/** A bed explodes in the Nether and the End, so nothing here ever uses one there. */
export const bedsExplode = (dimension: string): boolean => /nether|end/i.test(dimension)

/** The game refuses sleep with hostile mobs within 8 blocks sideways and 5 up or down. */
export const MONSTER_RANGE = { horizontal: 8, vertical: 5 } as const
