# Biome tables

**Depends on:** [World discovery](world-discovery.md) (`ExplorationStrategy`, `BiomeReader`, the structure kinds), Configurable Minecraft version (`MC_VERSION`, see the [plan](../../DEVELOPMENT-PLAN/DEVELOPMENT-PLAN.md)).  
**Used by:** [World discovery](world-discovery.md) (the `guided` strategy of `explore_for_structure`).

Which biomes a structure generates in is data, chosen by the Minecraft version the bot connects as, so a new version needs a new file and no change to the search.

## What a table says

`src/knowledge/structure-biomes/`:

- `structure-biome-table.types.ts`: `BiomeRule` (`biomes`: where the structure generates; `neighbours`: biomes that border those and are worth walking into when no matching biome is in view; `never`: biomes it can never be in, which are not searched) and `VersionedBiomeTable` (`version`, `rules` per structure kind; a kind that is left out has no biome guidance).
- `1.21.1.ts`: the default table: village (plains, sunflower plains, meadow, desert, savanna, snowy plains, taiga), desert temple (desert), jungle temple (jungle, sparse jungle, bamboo jungle), pillager outpost (the village biomes plus groves, snowy slopes, and the peaks). Mineshaft, ruined portal, dungeon, stronghold, and ancient city are not there: they are not tied to a surface biome, and use the frontier search.
- `index.ts`: `STRUCTURE_BIOME_TABLES` (every version that has a table) and `DEFAULT_BIOME_TABLE_VERSION` (`'1.21.1'`, named once).

## Which table is used

`StructureBiomeTables` (`structure-biome-tables.ts`) is built with the version from the configuration (`MC_VERSION`, default 1.21.1):

- The table of that **exact** version is merged over the default table, so a version's file lists only the kinds that differ.
- A version with **no table of its own uses the default (1.21.1) table**, and says so once in the log: "No biome table for Minecraft 1.20.4: using the table for 1.21.1". The match is on the string as written, so `1.21.4` uses the default until a file for it is added.
- A biome name that the connected game does not have (`BiomeReader.knownBiomeNames`) is dropped with one warning per name, so a table that is out of date for a version cannot break a search. While the bot is not connected there are no names to check against and nothing is dropped. A kind whose biomes all vanish has no rule.

## Adding a version

1. Add `src/knowledge/structure-biomes/<version>.ts` exporting a `VersionedBiomeTable` with only the kinds that differ (or all of them).
2. Add it to `STRUCTURE_BIOME_TABLES` in `index.ts`.
3. Add a case for it to `test/unit/knowledge/structure-biome-tables.test.ts`. The search, the tool, and the other tests do not change.

## Tests

- **Unit:** the provider (the default and its kinds, the fallback with one log line, an exact version merged over the default, an unknown biome dropped with one warning, no rule when nothing is left, not connected, no default table), the explorer over painted biomes (`test/fakes/discovery-fakes.ts`), and the skill (guided finds the temple in fewer hops than the frontier search, the default table on another version, a kind with no rule, no tables, biome and mob searches, spiral).
- **Integration** (`discovery-flow.test.ts`): the real tables on a version without one: a guided search finds the temple, logs the fallback once, and saves the find.
- **E2E** (`test/e2e/world-discovery/`): a desert painted with `fillbiome` 90 to 150 blocks away with a temple in it: the guided search finds it in at most 8 hops.

[Back to the features index](../FEATURES.md)
