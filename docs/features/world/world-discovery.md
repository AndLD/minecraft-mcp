# World discovery

**Depends on:** [Tasks](../core/tasks.md) (a search is a task), [Persistent state](../core/persistent-state.md) (`WorldKnowledgeStore` is per world), [Survival reflexes](../survival/survival-reflexes.md) (stay active during the walk), [Server commands and teleporting](server-commands-and-teleporting.md) (`/locate`, optional).  
**Used by:** no other feature directly. Cave and canyon exploration (the second half of this phase) builds on it and on [Excavation](excavation.md).

Branch `feature/world-discovery`. "Find a village": the bot walks the Overworld in short hops, looks at the loaded blocks and mobs at every stop, and answers with the coordinates of the first structure of that kind it recognises. What it finds is saved per world, so it is still listed after a restart. Named places ("home", "the iron mine") are kept next to them.

## Tools

| Tool | What it does |
|---|---|
| `explore_for_structure` | Searches for exactly one of: a structure `kind` (village, desert_temple, jungle_temple, pillager_outpost, mineshaft, ruined_portal, dungeon, stronghold), a `biome` ("desert", "cherry grove"), or a `mob` ("fox", "wolf", "polar bear"). Options: `max_distance` (50-3000, default 500, measured from where the search starts), `max_minutes` (1-60, default 10), `strategy` (`frontier` default, or `spiral`), `use_locate` (default **false**: the bot explores like a regular player), `only_new`, `return_to` (a landmark to walk back to when it ends). A task. |
| `list_known_structures` | The structures found so far (`kind` filter), nearest first, with `source` and distance; also the biomes found (`biomes`, when no kind is given). |
| `set_landmark`, `list_landmarks`, `remove_landmark` | Named places. `set_landmark` without coordinates names where the bot stands; a second landmark of the same name replaces the first. |

Results: `found` (kind, coordinates, `source`, `detail`), `alreadyKnown`, `reached`, `distanceFromStart`, `discovered` (other structures seen on the way), `hops`, and `returned` when `return_to` was used. Failures: `not_found` (the detail has `stopped`: `exhausted`, `time`; how far it looked and what it saw), `stuck` (five trips in a row failed), `unknown_landmark`, `wrong_dimension`, `no_world_profile`, `aborted`.

## How it works

- **`WorldKnowledgeStore`** (`src/knowledge/`, `ProfileScoped`, document `knowledge` v1): landmarks and structures. A find within 96 blocks (across, ignoring height) of a known structure of the same kind is the same structure and is not added again. A place the server named (`source: locate`) is replaced by the exact spot once the bot sees the blocks (`source: scan`); the reverse never happens.
- **`StructureSignature`** (`structure-signatures.ts`): one class per kind, each reading `BlockScanner` and `EntityScanner` within a radius (48). They look for a **combination**, because one block is too easy to build by hand:
  - village: a bell with a villager, three path blocks, or hay; or two villagers with paths, hay, or two doors
  - desert temple: chiseled sandstone with a TNT chamber, or with orange and blue terracotta
  - jungle temple: 8 mossy cobblestone and a tripwire hook, dispenser, or sticky piston
  - pillager outpost: a pillager and 4 dark oak logs
  - mineshaft: 2 oak fences and 3 planks with cobwebs, 2 rails, or a chest minecart
  - ruined portal: crying obsidian (nothing else in the Overworld makes it) with netherrack, magma, or gold, and no working portal
  - dungeon: a spawner in 4 mossy cobblestone; stronghold: an end portal frame
  A new kind is a new signature plus a row in `structure-kinds.ts`.
- **`ExplorationStrategy`** (`exploration-strategies.ts`): `SpiralExplorer` (a square spiral of 40-block steps, kept inside the circle of `max_distance`), `FrontierExplorer` (grows the searched area like a blob: only cells beside ground already visited, the one cheapest by distance from the start plus distance from the bot, random tie-break through the injected `Random`; heading for the nearest cell alone wandered off in one direction and passed a village 60 blocks from the start twice in the e2e run), and `TowardExplorer` (short hops to a place too far to see). Biome-guided search is not built: the bot has no biome port yet.
- **`ExploreForStructureSkill`**: scan where it stands; with `use_locate`, ask the server (`locate`); then loop: next waypoint, find the ground of that column (`findSurface`: not a treetop, not water or lava, two open blocks above), `goToPosition`, scan. Waypoints over water or lava, or in columns that are not loaded, are skipped. Every structure seen is recorded, not only the wanted one. It stops when the wanted kind is seen, the strategy runs out of ground inside `max_distance`, the time is up, or five trips in a row fail.
- **`/locate`** (only with `use_locate: true`, which the agent sets only when the player asks for the server to be used; by default the bot finds things on foot as a regular player would): when `ServerCommands.available('locate')` is true the bot asks `locate structure <id>` first (dungeons cannot be located, and `only_new` skips it because the server names the nearest, which may be the known one). A reply is parsed for `[x, ~, z]`. Within `max_distance` the bot walks there in hops and the blocks it sees give the exact spot; beyond it, the place is only recorded (`reached: false`). A refusal or an unreadable reply falls back to walking.
- **A known structure answers at once** when one of that kind is within `max_distance`; `only_new: true` looks for another.

## Looking for a biome or a mob

- **Names** (`name-match.ts`): the player's words are lower-cased, the `minecraft:` prefix is dropped, and spaces become underscores. An exact game name wins alone (`forest` is only `forest`); otherwise every name that contains the word is wanted (`jungle` is `sparse_jungle` and `bamboo_jungle`, `bear` is `polar_bear`). A name that matches nothing fails `unknown_biome` or `unknown_mob` and lists similar names. The lists come from the game data (`BiomeReader.knownBiomeNames`, `EntityScanner.knownEntityNames`).
- **Biome**: the `BiomeReader` port (`MineflayerBiomeReader`, from the biome of the block the world reports) is sampled at the bot's spot and on three rings (16, 32, 48 blocks, 8 directions), nearest first, at every stop. The first sample in the wanted biome is the find; the bot then walks onto the ground there (`reached`). Finds are saved as biome records (`WorldKnowledgeStore.recordBiome`, same 96-block rule as structures) and a saved place within `max_distance` is answered at once (`only_new: true` looks for another). With one exact name and `use_locate`, the bot first asks `locate biome minecraft:<name>`.
- **Mob**: the nearest entity of that type within 48 blocks is the find; the bot walks up to it and reports where it stands then, with `detail` saying how many were in view. Mobs move, so they are never saved and never answered from memory. Wild mobs the server has not sent to the bot (outside its tracking range) cannot be seen; the search simply goes on.
- The structures seen on the way are recorded during a biome or mob search too.

## Gotchas

- Waypoints are 40 blocks apart so the next one is inside the chunks the server has already sent; the pathfinder cannot plan into unloaded ground.
- `findBlocks` and the scan see **loaded** chunks only, buried blocks included: a TNT chamber under a temple is seen from the surface, but nothing beyond the server's view distance is.
- The search is on foot on the surface of the Overworld. It does not dig or swim, and it does not handle the night (survival reflexes and the night policy still act). The Nether and the End are refused (`wrong_dimension`).
- Reflexes stay active: a search interrupted by a reflex is resumed like any task.

## Tests

- **Unit:** the store (persist, reload, corrupt file, dedupe, upgrade), each signature (positive, negative, near miss), spiral and frontier (bounds, no revisits, deterministic), the surface finder, the locate parser, the skill on a stateful flat world (`test/fakes/discovery-fakes.ts`: found, known, only_new, distance and time limits, lakes, failures, abort, landmark return, every `/locate` branch), and the tools.
- **Integration** (`discovery-flow.test.ts`): explore, find, persist, and a second run on the saved state answers without walking.
- **E2E** (`test/e2e/world-discovery/`): a desert temple and a village put down through RCON 55 to 60 blocks away are found on a flat Paper world; a second structure on the way is recorded; `knowledge.json` holds the find after `disconnect`; the bot walks back to a landmark; a search with nothing in range fails `not_found`. The e2e world is flat and generates no structures, so a real village from a fixed seed is a manual check.
