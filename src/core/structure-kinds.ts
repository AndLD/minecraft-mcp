/** The structures the bot knows how to recognize, and the id the server's `/locate structure` command uses for each. */
export const STRUCTURE_LOCATE_IDS = {
  village: '#minecraft:village',
  desert_temple: 'minecraft:desert_pyramid',
  jungle_temple: 'minecraft:jungle_pyramid',
  pillager_outpost: 'minecraft:pillager_outpost',
  mineshaft: '#minecraft:mineshaft',
  ruined_portal: '#minecraft:ruined_portal',
  stronghold: 'minecraft:stronghold',
  /** A monster room is not a structure the server can locate. */
  dungeon: undefined,
} as const satisfies Record<string, string | undefined>

export type StructureKind = keyof typeof STRUCTURE_LOCATE_IDS

export const STRUCTURE_KINDS = Object.keys(STRUCTURE_LOCATE_IDS) as [
  StructureKind,
  ...StructureKind[],
]

export const isStructureKind = (value: string): value is StructureKind =>
  Object.hasOwn(STRUCTURE_LOCATE_IDS, value)
