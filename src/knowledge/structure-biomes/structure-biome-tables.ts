import type { BiomeReader } from '../../core/biome.port.js'
import type { Logger } from '../../core/logger.js'
import type { StructureKind } from '../../core/structure-kinds.js'
import type {
  BiomeRule,
  StructureBiomeRules,
  VersionedBiomeTable,
} from './structure-biome-table.types.js'

export interface StructureBiomeTablesDeps {
  readonly tables: readonly VersionedBiomeTable[]
  /** The version whose table is the default. */
  readonly defaultVersion: string
  /** The Minecraft version the bot connects as. */
  readonly version: string
  /** Names the connected game knows; a name it does not know is dropped. */
  readonly biomes: BiomeReader
  readonly logger: Logger
}

/**
 * Which biomes each structure generates in, for the Minecraft version in use. The table of that exact version is
 * merged over the default table (so it can list only what differs); a version without a table uses the default,
 * and says so once. Biome names the game does not have are dropped with a warning, so a stale table cannot break a
 * search.
 */
export class StructureBiomeTables {
  private rules: StructureBiomeRules | undefined
  private readonly warned = new Set<string>()

  constructor(private readonly deps: StructureBiomeTablesDeps) {}

  /** The rule for a structure kind, or undefined when there is no biome guidance for it. */
  ruleFor(kind: StructureKind): BiomeRule | undefined {
    const rule = this.resolved()[kind]
    if (rule === undefined) return undefined
    const known = this.deps.biomes.knownBiomeNames()
    const keep = (names: readonly string[] | undefined): string[] =>
      (names ?? []).filter((name) => this.isKnown(name, known, kind))
    const biomes = keep(rule.biomes)
    if (biomes.length === 0) return undefined
    return { biomes, neighbours: keep(rule.neighbours), never: keep(rule.never) }
  }

  /** Which version's table is in use, for the result and the logs. */
  get source(): string {
    const { tables, version, defaultVersion } = this.deps
    return tables.some((table) => table.version === version) ? version : defaultVersion
  }

  private resolved(): StructureBiomeRules {
    if (this.rules !== undefined) return this.rules
    const { tables, version, defaultVersion, logger } = this.deps
    const own = tables.find((table) => table.version === version)
    const fallback = tables.find((table) => table.version === defaultVersion)
    if (own === undefined && version !== defaultVersion)
      logger.info(
        `No biome table for Minecraft ${version}: using the table for ${defaultVersion}, so biome-guided searches may be less exact.`,
      )
    this.rules = { ...fallback?.rules, ...own?.rules }
    return this.rules
  }

  /** An empty list of names means the game is not connected yet: nothing can be checked, so nothing is dropped. */
  private isKnown(name: string, known: readonly string[], kind: StructureKind): boolean {
    if (known.length === 0 || known.includes(name)) return true
    const key = `${kind}:${name}`
    if (!this.warned.has(key)) {
      this.warned.add(key)
      this.deps.logger.warn(
        `The biome table lists "${name}" for ${kind}, but Minecraft ${this.deps.version} has no such biome: ignored.`,
      )
    }
    return false
  }
}
