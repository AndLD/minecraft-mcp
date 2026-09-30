import type { StructureKind } from '../../core/structure-kinds.js'

/** Where a structure kind generates, in biome names as the game writes them (no `minecraft:`). */
export interface BiomeRule {
  /** Biomes the structure generates in. */
  readonly biomes: readonly string[]
  /** Biomes that border those: worth walking into when no matching biome is in view. */
  readonly neighbours?: readonly string[]
  /** Biomes the structure can never be in (an ocean for a desert temple): not searched at all. */
  readonly never?: readonly string[]
}

/** Rules per structure kind. A kind that is left out has no biome guidance. */
export type StructureBiomeRules = Partial<Record<StructureKind, BiomeRule>>

/** The rules for one Minecraft version. A version's table may list only the kinds that differ from the default. */
export interface VersionedBiomeTable {
  /** The version as `MC_VERSION` writes it, for example `1.21.1`. */
  readonly version: string
  readonly rules: StructureBiomeRules
}
