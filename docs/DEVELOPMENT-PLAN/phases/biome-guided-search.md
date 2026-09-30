# Phase 38: Biome-guided search

_Estimate: ¾ session._  
**Status:** done on `feature/biome-guided-search`. See [World discovery](../../features/world/world-discovery.md) and [Biome tables](../../features/world/biome-tables.md). Differences from this plan: the biome rules are in `src/knowledge/structure-biomes/` with the provider class `StructureBiomeTables` next to them; the tables cover village, desert temple, jungle temple, and pillager outpost (the other kinds have no biome rule and use the frontier search); the result has `searched` to say which strategy ran.

**Depends on:** [30 World discovery, including caves and canyons](world-discovery.md) (`ExplorationStrategy`, `BiomeReader`, the structure kinds), [33 Configurable Minecraft version](minecraft-version.md) (the version the tables are chosen by).  
**Needed by:** [46 Hardening and polish](hardening-polish.md).

`explore_for_structure` walks a spiral or a growing blob and knows nothing about the ground it is on, so a search for a desert temple can spend minutes in an ocean or a jungle where none can exist. Structures are tied to biomes, so the bot can steer by them. This phase adds a search strategy that uses biomes as clues, and the tables that say which biomes fit which structure, chosen per Minecraft version.

- Branch: `feature/biome-guided-search`. A `BiomeGuidedExplorer` (an `ExplorationStrategy`, so it is a new class and no switch changes) and a `StructureBiomeTables` provider. No new port: `BiomeReader` already reports the biome at a point.
- **The strategy.** From the bot's position it samples biomes on rings around it (the same sampling `explore_for_structure` already does for a biome search) and scores waypoints:
  1. **A matching biome in view** (one of the structure's biomes, for a village: plains, savanna, desert, taiga, snowy plains, and so on) scores highest; the bot heads for it, then spirals inside it, since the structure is somewhere in that biome.
  2. **No matching biome in view:** it heads for the **edge of the current biome** (the nearest sample whose biome differs), because a new biome is the only way to find a matching one. It prefers a different biome that borders a matching one when the table says which (for example a plains border for villages).
  3. **A biome that can never hold the structure** (an ocean for a desert temple) is left as soon as possible and not searched at all.
  4. **When nothing helps** (no table for this kind, a biome the table does not know, or every sample unhelpful) it falls back to the blob-growing frontier search, so it is never worse than today.
- **`strategy` option.** `explore_for_structure` gets `strategy: 'guided'` and it becomes the default for structure kinds that have a table; `frontier` and `spiral` stay available. A biome or mob search is unchanged.
- **Tables per Minecraft version.** Which biomes a structure generates in changes between versions (new biomes are added, generation rules move), so the tables are data, chosen by the version the bot connects as (`MC_VERSION`):
  - `src/knowledge/structure-biomes/` holds one file per version (for example `1.21.1.ts`), each exporting `{ version, tables: Record<StructureKind, { biomes: string[]; neighbours?: string[]; never?: string[] }> }`, and an `index.ts` that registers them.
  - `StructureBiomeTables.forVersion(version)` returns the table of that exact version when one is registered, and **otherwise the default table, which is the one written for 1.21.1**. It logs once (through the `Logger` port) that it fell back and which version it used, so a run on another version says so. The default is named in one constant, not repeated.
  - Adding a version is adding one file and one line in the index; the strategy, the tool, and the tests do not change. A version table may list only the kinds that differ (it is merged over the default), so a new version does not repeat the whole table.
  - Biome names are checked against the game data (`BiomeReader.knownBiomeNames`): a name in a table that the connected version does not have is dropped with a warning, so a stale table cannot break the search.
  - The `MC_VERSION` string is matched as written (`1.21.1`); a patch release without its own table (for example `1.21.4`) uses the default until a file is added for it.
- **Tables for 1.21.1** cover every kind in `structure-kinds.ts`: village, desert temple, jungle temple, pillager outpost, mineshaft, ruined portal, dungeon (any Overworld biome: guidance off), stronghold (any: guidance off, it is found by distance from the spawn ring and not by biome). Kinds without a useful biome rule simply have no guidance and use the frontier search.
- **Not in this phase:** the Nether and the End (the search is Overworld only), biome-guided search for mobs (a mob's biome table is a separate data set), and reading the world seed.
- **Docs.** The world discovery page (the strategies and the tables), a new short page for the version tables (how to add one), the AGENTS.md discovery item (`strategy`), and the backlog note.
- **Tests:**
  - unit: table resolution (an exact version, an unknown version falling back to the 1.21.1 default with one log line, a partial table merged over the default, a name the game does not know dropped), the strategy over a fake `BiomeReader` world (a matching biome in view is chosen and searched inside, no match heads for the edge of the biome, a biome that cannot hold the structure is left, no table falls back to the frontier search, deterministic with the injected `Random`), and the tool option
  - integration: `explore_for_structure` with `guided` on a stateful fake world with painted biomes: the structure is found in fewer hops than with the frontier strategy, and a run with another `MC_VERSION` uses the default and logs it
  - e2e (`test/e2e/world-discovery/`, extended): biomes painted with `fillbiome` (a desert patch far from the start among plains) and a temple put down in it; the guided search finds it in fewer hops than the frontier search from the same start
- **Exit criteria:** "find a desert temple" walks toward desert ground instead of spiralling around an ocean; the same code runs on another Minecraft version by adding one table file, and a version without a table uses the 1.21.1 default and says so.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
