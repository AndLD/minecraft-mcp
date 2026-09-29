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
| [22 World discovery, including caves and canyons](phases/world-discovery.md) | not started (cave flow added) |
| [23 Leading a player](phases/leading-a-player.md) | not started (added; standalone, small; works with any target and pairs with discovery) |
| [24 Autonomy: the bot's own will](phases/autonomy.md) | not started (added; switchable, off by default; needs the earlier skills to have something to choose from) |
| [25 Filling buckets with water and lava](phases/buckets.md) | not started (added after a live session: the bot cannot fill a bucket, so it needs a water bucket from the player for anything that places water) |
| [26 Breaking a block at exact coordinates](phases/break-block.md) | not started (added: `collect_block` only takes the nearest match) |
| [27 Crop field options: gate side and pumpkin fields](phases/crop-field-options.md) | not started (added after live sessions with the first field) |
| [28 Excavating upward and continuing an existing dig](phases/excavation-upward.md) | not started (added after a live session: deepening a quarry and its stair walls) |
| [29 Hardening and polish](phases/hardening-polish.md) | not started (was 14, then 19 to 23, then 25) |

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
| [22 World discovery, including caves and canyons](phases/world-discovery.md) | 2 sessions |
| [23 Leading a player](phases/leading-a-player.md) | ½ session |
| [24 Autonomy, the bot's own will](phases/autonomy.md) | 2.5 sessions |
| [25 Filling buckets with water and lava](phases/buckets.md) | ½ session |
| [26 Breaking a block at exact coordinates](phases/break-block.md) | ½ session |
| [27 Crop field options: gate side and pumpkin fields](phases/crop-field-options.md) | 1 session |
| [28 Excavating upward and continuing an existing dig](phases/excavation-upward.md) | 1 session |
| [29 Hardening and polish](phases/hardening-polish.md) | 1 session |

## Dependencies between phases

What each phase needs before it can be built or verified. "Optional" means it works without it but gains something (a better target, a safer default). Later phases build on the ports, state, and engines of the earlier ones, so a phase can be started once everything it needs is merged. Phase 29 (hardening) needs every other phase.

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
| [19 Railways](phases/railways.md) | 13, 14 | 9, 22 |
| [20 Sleeping and respawn point](phases/sleeping-respawn.md) | 3, 6 | 11, 12, 13 |
| [21 Signs](phases/signs.md) | 9, 13, 16 | - |
| [22 World discovery, including caves and canyons](phases/world-discovery.md) | 3, 5, 6 | 12, 14 |
| [23 Leading a player](phases/leading-a-player.md) | 3 | 18, 22 |
| [24 Autonomy, the bot's own will](phases/autonomy.md) | 5, 6, 7, 8, 9, 13, 14, 18 | 19, 20, 22 |
| [25 Filling buckets with water and lava](phases/buckets.md) | 3, 7, 13 | 14 |
| [26 Breaking a block at exact coordinates](phases/break-block.md) | 3, 7 | 13, 14 |
| [27 Crop field options: gate side and pumpkin fields](phases/crop-field-options.md) | 18 | 25 |
| [28 Excavating upward and continuing an existing dig](phases/excavation-upward.md) | 14, 15 | - |
| [29 Hardening and polish](phases/hardening-polish.md) | all earlier phases | |

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
  docs/               # everything but README and AGENTS: DEVELOPMENT-PLAN/ (root + phases/), features/ (index + per-feature files), BACKLOG.md, e2e-docker-server.md, feasibility-findings.md
  data/<profile>/     # gitignored: per-world state (knowledge, journal, notes, ...)
```

## Open items to confirm during execution

- ~~Whether the LAN world accepts the offline bot~~ Confirmed in the Phase 0 spike (see [feasibility findings](../feasibility-findings.md)); Paper fallback not needed. `MC_PORT` is now optional (decided): the port and world name come from the LAN broadcast. Still open: whether the hashed seed stays the same when the world is re-opened.
- Whether Claude Code channels/Monitor can replace polling for instant chat delivery (evaluate after Phase 2; polling is the baseline).
- Low-health threshold (default 8 of 20) and flee distance; tune during Phase 6 play testing.

## Next step

Awaiting your approval of this plan. On approval I start with **Phase 0** (feasibility spike) on its own branch from `development`, then Phase 1 and onward, pausing for a manual in-game check and your approval at the end of each phase.
