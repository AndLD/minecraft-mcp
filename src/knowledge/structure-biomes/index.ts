import { TABLE_1_21_1 } from './1.21.1.js'
import type { VersionedBiomeTable } from './structure-biome-table.types.js'

/** The version whose table is used when the connected version has none of its own. */
export const DEFAULT_BIOME_TABLE_VERSION = '1.21.1'

/**
 * Every version that has a table. Adding a version is one file next to `1.21.1.ts` and one line here; a table may
 * list only the kinds that differ from the default.
 */
export const STRUCTURE_BIOME_TABLES: readonly VersionedBiomeTable[] = [TABLE_1_21_1]
