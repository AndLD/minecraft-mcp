# Phase 30: World discovery, including caves and canyons

_Estimate: 2 sessions._  
**Status:** structure discovery is done on `feature/world-discovery` (see [World discovery](../../features/world/world-discovery.md)); the cave and canyon flow is done on `feature/cave-exploration` (see [Cave exploration](../../features/world/cave-exploration.md)); the water-bucket fall guard was not built (the pathfinder's drop limit is now 3). Not built from the list below: biome-guided exploration (no biome port), night handling, and the shipwreck signature.

**Depends on:** [3 Movement and perception](movement-perception.md), [5 Persistent state](persistent-state.md), [6 Survival reflexes](survival-reflexes.md), [12 Server commands and teleport](server-commands-teleport.md) (optional), [14 Excavation and mining](excavation-mining.md) (optional).  
**Needed by:** [19 Railways](railways.md) (optional), [31 Leading a player](leading-a-player.md) (optional).

- `WorldKnowledgeStore` (extended from the storage phase; built on `StateStore` under the world profile): persisted with landmarks (home, base) and discovered structures (kind, position, timestamp), next to the container index and storage rules.
- `StructureSignature` implementations detected from loaded chunks and entities:
  - village: bell, villager entities, hay bales, path blocks, house doors
  - desert temple: chiseled/cut sandstone patterns with tnt
  - jungle temple: mossy cobblestone clusters
  - others as needed (outpost, mineshaft rails/planks, ruined portal, dungeon spawner, shipwreck, stronghold...)
- `ExplorationStrategy` implementations: `SpiralExplorer`, `FrontierExplorer` (prefers unvisited chunks), optional biome-guided (villages in plains/desert/savanna/taiga; temples in desert/jungle).
- `ExploreForStructure` skill: wander, scan periodically, stop on hit, report coordinates, record to knowledge store; bounded by distance and time; returns to a landmark on request; safe travel (reflexes stay active, avoid deep water and lava, night handling).
- Optional accelerator: if the bot is opped, use `/locate structure ...` to seed targets; falls back to physical exploration.
- Tools (all state goes through `StateStore`): `explore_for_structure`, `list_known_structures`, `set_landmark`, `list_landmarks`.
- Branch: `feature/world-discovery`.
- **Cave and canyon exploration** (`feature/cave-exploration`, built after the excavation phase because it needs its lighting and hazard rules):
  - `CaveMap` reads the loaded chunks and finds the underground open space: connected air below the surface (caves, tunnels, abandoned mineshafts), and ravines (deep, narrow, open-to-sky canyons), each with entrances and unexplored frontier cells.
  - `CaveExplorer` (an `ExplorationStrategy`): nearest-frontier first, with limits (depth range, distance from the entrance, time), breadcrumbs so it can always walk back to the entrance, and a `return_to_start` stop condition (few torches left, low health, hunger, time up).
  - **Lighting on the way**: torches are placed in dark spots by the shared `LightManager` (block light below `min_light`, with a minimum spacing), on the right-hand wall going in so the way out is lit. Torches are crafted from coal or charcoal and sticks, or fetched from storage; without any left the flow stops (`no_torches`) instead of going on in the dark.
  - **What it looks for** (`find`): resources given by name or group (`diamond_ore`, `ores`, ...), or, when none are named, the valuable ones: diamond, gold, redstone, lapis, emerald, ancient debris (in the Nether); mob spawners (recorded with the spawned mob); and rare structures: mineshaft (rails, fences, chest minecarts), dungeon (mossy cobblestone room), stronghold, geode. Finds are recorded in the knowledge store with coordinates and reported in chat as they happen. With `mine: true` the ores it passes are mined (vein by vein, under the excavation hazard rule); by default it only reports them.
  - **Safety**: reflexes stay active (skeletons and creepers are fled from; the warden and the deep dark are avoided: an ancient city is reported and never entered); lava and water are never approached (the hazard rule below); no unsafe drops: the pathfinder's drop limit stays at 3 and the deferred **fall-damage guard** (water-bucket landing) is built in this feature because caves have drops; no diving.
  - Tool: `explore_caves` (`find`, `mine`, `max_distance`, `max_minutes`, `min_light`), results through `list_known_structures`.
  - **Tests**: unit: `CaveMap` on synthetic grids (connected components, ravine detection, entrances, frontier), `CaveExplorer` (no revisits, budgets, breadcrumb return, torch spacing with a fake light source, each stop condition), find rules (specified versus default valuables, spawner, structure signatures); integration: explore → find → persist → new app instance still lists it; e2e: a cave carved via RCON with a diamond ore and a spawner at its far end and a lava pocket beside the path: the bot finds both, lights the way, never touches the lava, and walks back out; the torches are where the light rule says.
  - **Exit criteria:** "explore this cave for diamonds" makes the bot go in, light its way, report where it found diamonds, spawners, or other structures, and come back out alive.
- **Tests:**
  - unit: each `StructureSignature` against synthetic block/entity grids (positive, negative, near-miss), exploration strategies (deterministic with a fake `Random`, no revisits, respect bounds), `ExploreForStructure` (found, time/distance limit, abort)
  - integration: `WorldKnowledgeStore` against a real temp directory (persist, reload, corrupt file handling); explore → discover → persist → new app instance still lists the structure
  - e2e: on a fixed-seed world (seed chosen so a village is within reach of spawn, ground truth confirmed with `/locate`), `explore_for_structure` finds the village within a bounded time and the coordinates are close to the truth; a pre-built signature structure placed via RCON is detected
- **Exit criteria:** "find a village" makes the bot explore and report village coordinates in chat, and that structure remains listed after restart.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
