# Development Plan

Goal: a Mineflayer-based MCP server so Claude can play survival Minecraft 1.21.1 with the user: gather, craft, build, discover structures, following in-game chat instructions. Architecture rules are in [AGENTS.md](../../AGENTS.md).

## Decisions (fixed)

| Topic | Decision |
|---|---|
| Language | TypeScript (strict), ESM, Node 22+ |
| Minecraft | 1.21.1 vanilla, LAN world from TLauncher, bot in offline auth |
| Transport | MCP over stdio, `@modelcontextprotocol/sdk` |
| Config | `.env`: `MC_HOST=localhost` (default), `MC_PORT` (optional: when empty the port is discovered from the LAN world broadcast), plus the variables listed in README. The `connect` tool can override host/port at runtime |
| Instruction channel | In-game chat → `ChatRouter` → `AgentInbox` → agent long-polls `wait_for_chat` |
| Real-time behavior | Static-code reflexes (eat, flee, lava, drowning, `stop`); the agent only issues high-level goals |
| Threat policy | Flee from skeletons, creepers, and at low health; fight other hostile mobs; ignore endermen. A data table: [threat policy](../features/survival/threat-policy.md) |
| Block collection | Own `CollectBlocks` skill built on pathfinder behind the `Digger` port; `mineflayer-collectblock` is not used (can be swapped in later behind the same port) |
| Hunting | A dedicated flow (not reflex combat) with protection for tamed, named, and last-breeding-pair animals; low food is a policy. See [hunting and food](../features/gathering/hunting-and-food.md) |
| Item handover | Give items on request: inventory first, then remembered chests, dropped at the player's feet or put in a chest; reserve items are kept. See [handing items over](../features/storage/handing-items-over.md) |
| Drop recovery | Automatic by default, skippable, never into lava or void (it asks). See [drop recovery](../features/storage/drop-recovery.md) |
| Persistence | Everything worth remembering is saved per world profile through a `StateStore`; interrupted tasks are offered for resume, never auto-resumed; `connect` returns a session briefing. See [persistent state](../features/core/persistent-state.md) |
| World identity | Detected automatically from server signals, falling back to a user-given profile name. See [persistent state](../features/core/persistent-state.md) |
| Storage | Chests are first-class: rules map items to containers, and inventory-full handling is a policy (ask by default). See [storage](../features/storage/storage.md) |
| Architecture | Ports and adapters, SOLID, Mineflayer isolated in `src/bot/`; details in [AGENTS.md](../../AGENTS.md) |
| Testing | Jest with unit, integration, and Docker e2e tiers; rules in [AGENTS.md](../../AGENTS.md) |
| Testability | All code is testable by construction (see the hard rules in [AGENTS.md](../../AGENTS.md)) |
| Git workflow | Git Flow with a branch and pull request per phase or feature; rules in [AGENTS.md](../../AGENTS.md) |
| E2E environment | Paper 1.21.1 in Docker driven through RCON; see [the e2e server](../e2e-docker-server.md) |
| Tooling | eslint, prettier, tsx (dev), tsc (build), Jest, testcontainers, rcon-client |

## Risks and how the plan addresses them

| Risk | Mitigation |
|---|---|
| LAN world may reject offline-mode bots | Phase 0 spike proves it first. Fallback: install a local Paper 1.21.1 server with `online-mode=false` (the code does not change, only the host/port) |
| Random LAN port every session | `connect` accepts host/port overrides; documented flow. If the spike shows the LAN broadcast is readable, the port can be discovered automatically |
| Coordinates from one world pollute another (LAN worlds have no stable address) | Per-world profiles. World fingerprint detected automatically; user-given name as fallback; mismatch warnings in the session briefing |
| Interrupted tasks resumed blindly after a relaunch | Task journal marks them `interrupted`; the agent asks the user before resuming |
| Corrupted or outdated state files | Atomic writes, backup copy, schema versions with migrations, fall back to an empty state with a warning |
| Agent latency (seconds per turn) | Coarse tools, autonomous tasks, reflexes in code, event log returned with chat |
| Tool calls time out on long work | Task model: bounded wait, then `running` + `get_task_status` / `cancel_task` |
| Structures are not queryable from the client | Physical exploration + signature detection on loaded chunks; optional `/locate` accelerator when the bot is opped |
| Building is fiddly (reach, placement faces, terrain) | Blueprint layer with layer-by-layer placement, scaffolding, verification pass, and retries |
| Pathfinder gets stuck | Stuck detection in `Navigator` adapter, timeouts, and clear failure reasons for the agent |
| Bot empties or fills the wrong chests | Explicit rules and labels, `protected` flag, reserve list for tools and food, action reports in chat, index refresh on mismatch |
| Griefing player builds | Protected landmarks; the digger refuses protected areas unless overridden |
| stdout pollution breaks the MCP protocol | Logger writes to stderr only; lint rule bans `console.log` |
| Jest with native ESM is fiddly (`--experimental-vm-modules`, `.js` import mapping) | Solved once in Phase 1 with a working config and a sample test before any feature code |
| Hunting wipes out animals or kills someone's pets | `AnimalCatalog` protection rules: never attack tamed animals, named animals, villagers and golems; keep a breeding pair per species in the area by default; user can override per call |
| Dropped items get lost (lava, void, despawn after 5 minutes, bot re-collects its own drop) | Safe drop spot check, drop from a distance and step back, verify pickup, chest mode for large amounts; unclaimed items and death drops are handled by the drop-recovery feature with a despawn deadline |
| Death loops (bot dies again while recovering its drop) | Hazard assessment before approaching, staged approach, max attempts (default 2), and asking the user when the spot is unsafe; the user can skip recovery at any time |
| Fakes drift from real Mineflayer behavior | Adapters are thin and unit-tested against a stub of the Mineflayer API; the Docker e2e suite (from the e2e-harness feature) runs the real bot against a real server; each phase still ends with a manual in-game check |
| E2E tests are slow and timing-sensitive | Small smoke-level suite (a handful of scenarios per phase), deterministic world (superflat or fixed seed), mobs and time controlled via RCON, generous timeouts, kept out of `npm test`; failures dump server and bot logs |
| E2E needs Docker and the server EULA | Documented prerequisite; the e2e scripts fail fast with a clear message when Docker is missing; EULA accepted through the container env |

## Status

| Phase | Status |
|---|---|
| [0 Feasibility spike](phases/feasibility-spike.md) | done, merged into `development` |
| [1 Project scaffold](phases/project-scaffold.md) | done, merged into `development` |
| [2 Core skeleton and MCP shell](phases/core-skeleton-mcp-shell.md) | done, merged into `development` |
| [3 Movement and perception](phases/movement-perception.md) | done, merged into `development` |
| [4 E2E test harness](phases/e2e-harness.md) | done, merged into `development` |
| [5 Persistent state](phases/persistent-state.md) | done, merged into `development` |
| [6 Survival reflexes](phases/survival-reflexes.md) | done, merged into `development` |
| [7 Gathering, crafting, smelting](phases/gathering-crafting-smelting.md) | done, merged into `development` |
| [8 Hunting and food](phases/hunting-food.md) | done, merged into `development` |
| [9 Storage and containers](phases/storage-containers.md) | done, merged into `development` |
| [10 Item handover](phases/item-handover.md) | done, merged into `development` |
| [11 Drop recovery](phases/drop-recovery.md) | done, merged into `development` |
| [12 Server commands and teleport](phases/server-commands-teleport.md) | done, merged into `development` |
| [13 Construction engine and building](phases/construction-building.md) | done: engine merged (`feature/construction-engine`); house, shelter, custom shapes, and pillaring up in `feature/building`; all merged into `development` |
| [14 Excavation and mining](phases/excavation-mining.md) | shapes, hazard rule, torches, and ore veins done (`feature/excavation` and `feature/excavation-extras`: stair exit, water landing, spoil policy, torch and spare-tool crafting); stair sizing (`feature/excavation-stair-sizing`), cave sealing (`feature/excavation-cave-sealing`), and staircase target/width (`feature/excavation-staircase-target`) done; all merged into `development` |
| [15 Structured gathering: pits and quarries instead of scattered holes](phases/structured-gathering.md) | done (`feature/structured-gathering`), merged into `development` |
| [16 Site preparation: leveling, dug rooms, and opening doors](phases/site-preparation.md) | site leveling done (`feature/site-leveling`), merged into `development`; dug rooms done (`feature/dug-rooms`), merged into `development`; door opening done (`feature/door-opening`), merged into `development` |
| [17 Iron doors and switches](phases/iron-doors-switches.md) | done (`feature/switches`), merged into `development` |
| [18 Farming, crops, animals, and trees](phases/farming.md) | crop farming done (`feature/crop-farming`: `build_farm` field layout, `plant_crops`, `harvest_crops`, `tend_farm`, `inspect_farm`, `list_farms`, `register_farm`); animal farming done (`feature/animal-farming`: `build_farm` pen layout, `lure_animals`, `breed_animals`, `HerdManager` in `tend_farm`/`inspect_farm`); egg collection done (`feature/egg-collection`: `collect_eggs`, `set_egg_policy`, wired into `tend_farm` for chicken pens); tree farming done (`feature/tree-farming`: `plant_trees`, `harvest_trees`, groves in `list_farms`/`inspect_farm`/`tend_farm`); sapling collecting done (`feature/sapling-collecting`: `collect_saplings`, and `saplings` on `collect_block`, on request only); discover_farm done (`feature/discover-farm`: proposes fields and pens found by scanning, registers nothing); moved ahead of railways, which nothing here depends on |
| [19 Railways](phases/railways.md) | done (`feature/railways`: `plan_railway`, `build_railway`, `place_minecart`; surface and tunnel routes, economy and rich variants, verification and repair) |
| [20 Sleeping and respawn point](phases/sleeping-respawn.md) | done (`feature/sleeping`: `sleep`, `set_respawn_point`, `place_bed`, `list_beds`, `set_sleep_policy`; the night policy, waking before reflexes, and noticing a lost bed after a death) |
| [21 Signs](phases/signs.md) | done (`feature/signs`: `place_sign`, `edit_sign`, `remove_sign`, `read_signs`; wall and standing signs, beside a labelled chest, sign items fetched or crafted, text read back, never removes more than the one sign named) |
| [22 Filling buckets with water and lava](phases/buckets.md) | done (`feature/buckets`: `fill_bucket`; water and lava into empty buckets, source blocks only, the pond stays when two sources touch a block, lava refused in protected areas and beside player builds unless the block is named, taken only from a spot lava cannot reach) |
| [23 Breaking a block at exact coordinates](phases/break-block.md) | done (`feature/break-block`: `break_block`; one block at coordinates or the one looked at, refusals as values, `override_protection` on the player's direct words only) |
| [24 Farming fixes](phases/farming-fixes.md) | done (`fix/farming-fixes`: the gate now lies along the fence, fields are watered by a `trench` (default) or `spots` layout, `lure_animals` reports `penFull` only for a full pen and walks up to the animal and waits for it, a pen clears its interior) |
| [25 Crop field options: gate side and pumpkin fields](phases/crop-field-options.md) | done (`feature/crop-field-options`: `gate_side` on `build_farm` for fields and pens, stored with the farm; `crop: pumpkin` builds a stem field with free rows between the stems, `harvest_crops` takes the pumpkins and leaves the stems; moving the gate of an existing field is not built) |
| [26 Closing gates and doors behind the bot](phases/closing-doors-behind.md) | done (`feature/closing-doors-behind`: doors the bot opens are closed on every path, leftovers on the next trip, pen gates checked at the end of pen tasks; a door found open is left alone) |
| [27 Excavation reliability](phases/excavation-reliability.md) | done (`feature/excavation-reliability`: the cave-sealing bug reproduced and fixed, every shape read back at the end with stray blocks cleared and special blocks kept, `falling_blocks: 'clear'`, the exact blocking cells in `ended`, and the `dig_to` shape) |
| [28 Excavating upward and continuing an existing dig](phases/excavation-upward.md) | done (`feature/excavation-upward`: `continue_existing` from a record of the bot's own digs, `order: bottom_up` for pit, shaft, and quarry; a dig made by hand is not recognised and asks for its origin) |
| [29 Placement fixes: furnaces, and signs on fences](phases/placement-fixes.md) | done (`feature/placement-fixes`: the furnace cause was a click that opens the furnace, fixed by sneaking; a sign tries several standing spots, names free places when blocked, and takes `replace_block`) |
| [30 World discovery, including caves and canyons](phases/world-discovery.md) | done (`feature/world-discovery`: structure, biome, and mob search, landmarks, `WorldKnowledgeStore`, `/locate` only on request; `feature/cave-exploration`: `explore_caves` with lit, hazard-aware exploration, finds, and vein mining) |
| [31 Open-vein gathering](phases/open-vein-gathering.md) | done (`feature/open-vein-gathering`: ores are gathered by veins the bot can walk to, exploring caves for them; tunnelling only on request) |
| [32 Leading a player](phases/leading-a-player.md) | done (`feature/leading-a-player`: `lead_player` walks in legs, never farther than the lead distance from the player, waits and calls, goes back to a player who wanders) |
| [33 Configurable Minecraft version](phases/minecraft-version.md) | in review (`feature/configurable-minecraft-version`: `MC_VERSION`, default 1.21.1, followed by the bot, the e2e server, and the player bots) |
| [34 Tall trees completion](phases/tall-trees.md) | done (`feature/tall-trees`: `harvest_trees` climbs a dirt tower beside a tall trunk, `reach_tall` `pillar` or `skip`, and always takes the tower down) |
| [35 Fishing](phases/fishing.md) | done (`feature/fishing`: `fish` from the shore with a rod, sorting fish, treasure, and junk, optional cooking, and the `fish_and_cook` food policy) |
| [36 Smelting wait strategy](phases/smelting-wait.md) | done (`feature/smelting-wait`: the furnace window is closed between looks, a cancelled wait leaves the furnace burning and remembers the job in `SmeltJobs`, `smelt` again or `collect: true` takes it, `wait: start_only`, and out of fuel is judged by a stalled furnace) |
| [37 Organize storage](phases/organize-storage.md) | done (`feature/organize-storage`: `organize_storage` looks into the containers, plans the moves against the room each will have, and carries them out one trip per source; `dry_run` is the default) |
| [38 Biome-guided search](phases/biome-guided-search.md) | done (`feature/biome-guided-search`: `BiomeGuidedExplorer`, `strategy: guided` by default, biome tables per Minecraft version with the 1.21.1 table as the default) |
| [39 Tall trees, cutting leaves](phases/tall-tree-leaves.md) | done (`feature/tall-tree-leaves`: the tower planner goes through the tree's own leaves and digs them before the bot climbs into them; `leavesCut` in the result) |
| [40 Torches from storage for caves](phases/cave-torch-supply.md) | done (`feature/cave-torch-supply`: `explore_caves` fetches torches, or coal and sticks, from storage before going in and after walking out when they run out; `restock`) |
| [41 Smelting, fuel top-up and a ready signal](phases/smelting-fuel-and-ready.md) | done (`feature/smelting-fuel-and-ready`: fuel of every kind in the bag is used and topped up at each look, `fuelUsed`, `fuel_from_storage`, a `smelt_ready` event for a job left in a furnace, a far or other-dimension warning) |
| [42 Blast furnace and smoker](phases/blast-furnace-smoker.md) | done (`feature/blast-furnace-smoker`: `smelt` uses a nearby or carried blast furnace for ores and a smoker for food, twice as fast and twice as far on the same fuel; `station` option) |
| [43 Campfire cooking](phases/campfire-cooking.md) | done (`feature/campfire-cooking`: `smelt` cooks raw food on a campfire beside the bot with no fuel and no window, four at a time; `station: campfire`, and `auto` uses one when the bag has no fuel or the batch is small) |
| [44 Farming extras, shearing, milking, and melons](phases/farming-extras.md) | not started (from the backlog) |
| [45 Composter and bone meal fertilization](phases/composter-bone-meal.md) | not started (from the backlog: fertilize a whole field on ask) |
| [46 Take an item the player hands over](phases/receive-item.md) | not started (from the backlog: `receive_item`, the reverse of `give_items`) |
| [47 Hardening and polish](phases/hardening-polish.md) | not started (renumbered as phases were added and removed; was 14 at first) |

## Phases


Each phase ends with working, tested software and a manual check in the game. Estimates are rough working-session counts. Every phase (and any later feature) gets its own branch from `development` and its own e2e folder; see [AGENTS.md](../../AGENTS.md) for the workflow and test rules.

Each phase has its own detail file with the scope, tasks, tests, and exit criteria.

| Phase | Estimate |
|---|---|
| [0 Feasibility spike](phases/feasibility-spike.md) | ½ session |
| [1 Project scaffold](phases/project-scaffold.md) | ½ session |
| [2 Core skeleton and MCP shell](phases/core-skeleton-mcp-shell.md) | 1 session |
| [3 Movement and perception](phases/movement-perception.md) | 1 session |
| [4 E2E test harness](phases/e2e-harness.md) | 1 session |
| [5 Persistent state](phases/persistent-state.md) | 1.5 sessions |
| [6 Survival reflexes](phases/survival-reflexes.md) | 1 session |
| [7 Gathering, crafting, smelting](phases/gathering-crafting-smelting.md) | 1.5 sessions |
| [8 Hunting and food](phases/hunting-food.md) | 1 session |
| [9 Storage and containers](phases/storage-containers.md) | 1.5 sessions |
| [10 Item handover](phases/item-handover.md) | ½ session |
| [11 Drop recovery](phases/drop-recovery.md) | 1 session |
| [12 Server commands and teleport](phases/server-commands-teleport.md) | ½ session |
| [13 Construction engine and building](phases/construction-building.md) | 2 sessions |
| [14 Excavation and mining](phases/excavation-mining.md) | 3.25 sessions |
| [15 Structured gathering: pits and quarries instead of scattered holes](phases/structured-gathering.md) | 1 session |
| [16 Site preparation: leveling, dug rooms, and opening doors](phases/site-preparation.md) | 2 sessions |
| [17 Iron doors and switches](phases/iron-doors-switches.md) | ¾ session |
| [18 Farming, crops, animals, and trees](phases/farming.md) | 3.25 sessions |
| [19 Railways](phases/railways.md) | 2 sessions |
| [20 Sleeping and respawn point](phases/sleeping-respawn.md) | 1 session |
| [21 Signs](phases/signs.md) | ½ session |
| [22 Filling buckets with water and lava](phases/buckets.md) | ½ session |
| [23 Breaking a block at exact coordinates](phases/break-block.md) | ½ session |
| [24 Farming fixes](phases/farming-fixes.md) | 1 session |
| [25 Crop field options: gate side and pumpkin fields](phases/crop-field-options.md) | 1 session |
| [26 Closing gates and doors behind the bot](phases/closing-doors-behind.md) | ½ session |
| [27 Excavation reliability](phases/excavation-reliability.md) | 1½ sessions |
| [28 Excavating upward and continuing an existing dig](phases/excavation-upward.md) | 1 session |
| [29 Placement fixes: furnaces, and signs on fences](phases/placement-fixes.md) | ½ session |
| [30 World discovery, including caves and canyons](phases/world-discovery.md) | 2 sessions |
| [31 Open-vein gathering](phases/open-vein-gathering.md) | ½ session |
| [32 Leading a player](phases/leading-a-player.md) | ½ session |
| [33 Configurable Minecraft version](phases/minecraft-version.md) | ¼ session |
| [34 Tall trees completion](phases/tall-trees.md) | ½ session |
| [35 Fishing](phases/fishing.md) | 1 session |
| [36 Smelting wait strategy](phases/smelting-wait.md) | ½ session |
| [37 Organize storage](phases/organize-storage.md) | ½ session |
| [38 Biome-guided search](phases/biome-guided-search.md) | ¾ session |
| [39 Tall trees, cutting leaves](phases/tall-tree-leaves.md) | ¼ session |
| [40 Torches from storage for caves](phases/cave-torch-supply.md) | ¼ session |
| [41 Smelting, fuel top-up and a ready signal](phases/smelting-fuel-and-ready.md) | ½ session |
| [42 Blast furnace and smoker](phases/blast-furnace-smoker.md) | ½ session |
| [43 Campfire cooking](phases/campfire-cooking.md) | ½ session |
| [44 Farming extras, shearing, milking, and melons](phases/farming-extras.md) | 1 session |
| [45 Composter and bone meal fertilization](phases/composter-bone-meal.md) | ¾ session |
| [46 Take an item the player hands over](phases/receive-item.md) | ½ session |
| [47 Hardening and polish](phases/hardening-polish.md) | 1 session |

## Dependencies between phases

What each phase needs before it can be built or verified. "Optional" means it works without it but gains something (a better target, a safer default). Later phases build on the ports, state, and engines of the earlier ones, so a phase can be started once everything it needs is merged. Phase 47 (hardening) needs every other phase.

| Phase | Needs | Optional |
|---|---|---|
| [0 Feasibility spike](phases/feasibility-spike.md) | - | - |
| [1 Project scaffold](phases/project-scaffold.md) | 0 | - |
| [2 Core skeleton and MCP shell](phases/core-skeleton-mcp-shell.md) | 1 | - |
| [3 Movement and perception](phases/movement-perception.md) | 2 | - |
| [4 E2E test harness](phases/e2e-harness.md) | 2, 3 | - |
| [5 Persistent state](phases/persistent-state.md) | 2 | - |
| [6 Survival reflexes](phases/survival-reflexes.md) | 2, 3 | - |
| [7 Gathering, crafting, smelting](phases/gathering-crafting-smelting.md) | 3, 5 | - |
| [8 Hunting and food](phases/hunting-food.md) | 3, 6, 7 | 5 |
| [9 Storage and containers](phases/storage-containers.md) | 3, 5, 7 | - |
| [10 Item handover](phases/item-handover.md) | 3, 9 | - |
| [11 Drop recovery](phases/drop-recovery.md) | 5, 6, 7, 10 | - |
| [12 Server commands and teleport](phases/server-commands-teleport.md) | 3 | - |
| [13 Construction engine and building](phases/construction-building.md) | 3, 7, 9 | 5 |
| [14 Excavation and mining](phases/excavation-mining.md) | 13 | 7, 9 |
| [15 Structured gathering: pits and quarries instead of scattered holes](phases/structured-gathering.md) | 7, 14 | - |
| [16 Site preparation: leveling, dug rooms, and opening doors](phases/site-preparation.md) | 3, 13, 14 | - |
| [17 Iron doors and switches](phases/iron-doors-switches.md) | 16 | 9 |
| [18 Farming, crops, animals, and trees](phases/farming.md) | 7, 8, 9, 13 | 16 |
| [19 Railways](phases/railways.md) | 13, 14 | 9, 30 |
| [20 Sleeping and respawn point](phases/sleeping-respawn.md) | 3, 6 | 11, 12, 13 |
| [21 Signs](phases/signs.md) | 9, 13, 16 | - |
| [22 Filling buckets with water and lava](phases/buckets.md) | 3, 7, 13 | 14 |
| [23 Breaking a block at exact coordinates](phases/break-block.md) | 3, 7 | 13, 14 |
| [24 Farming fixes](phases/farming-fixes.md) | 18 | 16 |
| [25 Crop field options: gate side and pumpkin fields](phases/crop-field-options.md) | 18, 24 | 22 |
| [26 Closing gates and doors behind the bot](phases/closing-doors-behind.md) | 16 | 18 |
| [27 Excavation reliability](phases/excavation-reliability.md) | 14, 15 | - |
| [28 Excavating upward and continuing an existing dig](phases/excavation-upward.md) | 14, 15 | - |
| [29 Placement fixes: furnaces, and signs on fences](phases/placement-fixes.md) | 13, 21 | 16 |
| [30 World discovery, including caves and canyons](phases/world-discovery.md) | 3, 5, 6 | 12, 14 |
| [31 Open-vein gathering](phases/open-vein-gathering.md) | 13, 14, 30 | |
| [32 Leading a player](phases/leading-a-player.md) | 3 | 18, 30 |
| [33 Configurable Minecraft version](phases/minecraft-version.md) | 2, 4 | |
| [34 Tall trees completion](phases/tall-trees.md) | 7, 13, 18 | |
| [35 Fishing](phases/fishing.md) | 3, 7, 8 | 9, 30 |
| [36 Smelting wait strategy](phases/smelting-wait.md) | 5, 7 | 9 |
| [37 Organize storage](phases/organize-storage.md) | 9 | |
| [38 Biome-guided search](phases/biome-guided-search.md) | 30, 33 | |
| [39 Tall trees, cutting leaves](phases/tall-tree-leaves.md) | 13, 34 | |
| [40 Torches from storage for caves](phases/cave-torch-supply.md) | 7, 9, 30 | |
| [41 Smelting, fuel top-up and a ready signal](phases/smelting-fuel-and-ready.md) | 36 | 9 |
| [42 Blast furnace and smoker](phases/blast-furnace-smoker.md) | 7, 36, 41 | |
| [43 Campfire cooking](phases/campfire-cooking.md) | 7, 8, 42 | |
| [44 Farming extras, shearing, milking, and melons](phases/farming-extras.md) | 7, 8, 18 | |
| [45 Composter and bone meal fertilization](phases/composter-bone-meal.md) | 18, 44 | 7, 9 |
| [46 Take an item the player hands over](phases/receive-item.md) | 3, 7, 10, 11 | |
| [47 Hardening and polish](phases/hardening-polish.md) | all earlier phases | |

Feature-level dependencies (which feature reuses which feature's classes) are listed in the [features index](../features/FEATURES.md) and at the top of each feature file.

## Testing strategy and Git workflow

The rules live in [AGENTS.md](../../AGENTS.md) so that they exist in one place only: the three test tiers, the e2e conventions and run policy, the coverage gate, and the Git Flow branching and pull-request rules. In short for planning purposes: a phase is done when its unit, integration, and own e2e tests pass and the manual check below is done; the complete e2e suite runs once at the final gate ([hardening](phases/hardening-polish.md)) and before any release merge into `main`.

## Manual in-game check (used at the end of each phase)

This is a human verification step with the real game client, in addition to the automated e2e suite. It also covers what Docker cannot: your actual LAN world and the in-game chat UX.

1. Start Minecraft 1.21.1, open the world to LAN, note the port.
2. Start the MCP client, `connect` with the port; the bot appears.
3. Run the phase's exit-criteria scenarios via in-game chat.
4. Check stderr logs for errors and unexpected stdout output.
5. Verify `stop` interrupts within about a second.

## Suggested repository layout at completion

```
minecraft-mcp/
  README.md  AGENTS.md  CLAUDE.md
  package.json  tsconfig.json  eslint.config.js  jest.config.js
  .env.example  .gitignore
  src/
    index.ts  app.ts
    config/  core/  bot/  chat/  perception/
    skills/{movement,gathering,crafting,building,discovery}/
    reflexes/  tasks/  state/  knowledge/
    mcp/{server.ts,tool-registry.ts,tools/}
  test/{unit,integration,fakes}/
  test/e2e/<feature>/   # e2e grouped per feature (movement-perception/, survival-reflexes/, ...)
  docker/             # e2e server configuration
  docs/               # everything but README and AGENTS: DEVELOPMENT-PLAN/ (root + phases/), features/ (index + per-feature files), backlog/ (BACKLOG.md as an index, COMPLETED-BACKLOG.md, and features/ with one file per area), e2e-docker-server.md, feasibility-findings.md
  data/<profile>/     # gitignored: per-world state (knowledge, journal, notes, ...)
```

## Open items to confirm during execution

- ~~Whether the LAN world accepts the offline bot~~ Confirmed in the Phase 0 spike (see [feasibility findings](../feasibility-findings.md)); Paper fallback not needed. `MC_PORT` is now optional (decided): the port and world name come from the LAN broadcast. Still open: whether the hashed seed stays the same when the world is re-opened.
- Whether Claude Code channels/Monitor can replace polling for instant chat delivery (evaluate after Phase 2; polling is the baseline).
- Low-health threshold (default 8 of 20) and flee distance; tune during Phase 6 play testing.

## Next step

Awaiting your approval of this plan. On approval I start with **Phase 0** (feasibility spike) on its own branch from `development`, then Phase 1 and onward, pausing for a manual in-game check and your approval at the end of each phase.
