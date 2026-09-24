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
| Threat policy | Always flee from skeletons and creepers; always flee at low health; fight all other hostile mobs (zombies, spiders, etc.); ignore endermen. Encoded as a data table, see [the threat policy](../features/survival/threat-policy.md) |
| Block collection | Own `CollectBlocks` skill built on pathfinder behind the `Digger` port; `mineflayer-collectblock` is not used (can be swapped in later behind the same port) |
| Hunting | A dedicated hunting flow (not just reflex combat): find huntable animals, approach, kill with correct attack timing, collect drops, optionally cook and store the food. Tamed, named, and last-breeding-pair animals are protected by default. Low food is handled by a policy: ask by default, or hunt and cook when the user's instruction allows it |
| Item handover | The bot can give items to a player on request: fetch the items (inventory first, then remembered chests), walk to the player, drop them at a safe distance so they land at the player's feet, verify they were picked up, and retry or report. Large amounts can go into a chest instead. Reserve items (current tools, armor, food) are kept unless asked |
| Drop recovery | Automatic by default, skippable on the user's request. Covers the bot's own drops: its inventory after a death, and handed-over items nobody picked up. `auto` never wades into lava, void, or other hazards (it asks instead); the user can say "forget it" at any time, or set a standing instruction. Skipped drops are kept as records with coordinates and can be recovered later |
| Persistence | Everything worth remembering is saved per world profile through a `StateStore` (atomic JSON files under `DATA_DIR/<profile>/`): world knowledge, containers and rules, standing instructions, a task journal (interrupted tasks are offered for resume, never auto-resumed), an instruction/event log, and agent notes. On `connect` the bot returns a session briefing |
| World identity | Detected automatically first (fingerprint from signals the server exposes, such as the hashed seed, world name/MOTD, spawn point); if it cannot be determined or is ambiguous, fall back to a profile name given by the user (`WORLD_PROFILE` or `connect(profile)`) |
| Storage | Chests are first-class. The user can designate specific containers for specific kinds of items (rules); with no matching rule the bot uses any chest with room. Inventory-full handling is a policy: ask the user by default, or offload to storage and return when the user's instruction (per call, or a standing instruction for the session) allows it |
| Architecture | Ports and adapters, SOLID; Mineflayer isolated in `src/bot/` |
| Testing | Jest (`@jest/globals`, TypeScript, ESM). Three automated tiers: unit and integration (offline, fast, run by `npm test`) and e2e against a real headless Minecraft 1.21.1 server in Docker. E2E tests are organized per phase: during a phase only that phase's own e2e tests are run; the complete e2e suite runs once, after all primary phases. Manual in-game checks remain a per-phase human step |
| Testability | All code is testable by construction: dependencies injected via ports, `Clock` and `Random` injected, the app wiring lives in a `createApp()` factory, and Mineflayer sits behind thin adapters |
| Git workflow | Git Flow. `main` = production, `development` = integration. Every phase or feature lives in its own branch created from `development` |
| E2E environment | Docker: `itzg/minecraft-server` (Paper 1.21.1, `ONLINE_MODE=FALSE`, RCON enabled) started by Jest global setup via `testcontainers`; scenarios prepared and verified through RCON |
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
| [20 Sleeping and respawn point](phases/sleeping-respawn.md) | not started (added; small, can go right after teleport) |
| [21 Signs](phases/signs.md) | not started (added; small, can go any time; uses the look target from Phase 15) |
| [22 World discovery, including caves and canyons](phases/world-discovery.md) | not started (cave flow added) |
| [23 Leading a player](phases/leading-a-player.md) | not started (added; standalone, small; works with any target and pairs with discovery) |
| [24 Autonomy: the bot's own will](phases/autonomy.md) | not started (added; switchable, off by default; needs the earlier skills to have something to choose from) |
| [25 Hardening and polish](phases/hardening-polish.md) | not started (was 14, then 19 to 23) |

## Phases


Each phase ends with working, tested software and a manual check in the game. Estimates are rough working-session counts.

Every phase (and any later feature) is developed in its own branch created from `development` (see [Git workflow](#git-workflow)). Every phase includes its own unit and integration tests, and from the e2e-harness feature onward also e2e scenarios for its user-facing behavior. While working on a phase, run **only that phase's own e2e tests** (not the ones from earlier phases); a phase is done when its unit, integration, and own e2e tests pass. The complete e2e suite is run once at the end (see the final gate in the hardening phase).

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
| [25 Hardening and polish](phases/hardening-polish.md) | 1 session |

## Testing strategy

Three automated tiers. Unit and integration run offline with no Minecraft and make up `npm test`. E2E runs against a real headless Minecraft server in Docker. Before a phase is merged into `development`, its unit and integration tests and **its own e2e tests** must pass; the complete e2e suite (all phases) is run once, at the final gate after all primary phases.

| Tier | Scope | Real parts | Fake parts | Location |
|---|---|---|---|---|
| Unit | One class or function | the unit under test | all its ports, `Clock`, `Random` | `test/unit/` (mirrors `src/`) |
| Integration | Several real modules wired together | MCP server + client (SDK in-memory transport), `ToolRegistry`, `TaskManager`, `AgentInbox`, reflex engine, skills, `WorldKnowledgeStore` on a temp dir, `createApp()` wiring | the outer ports (`Connection`, `Navigator`, scanners, `Digger`, `Placer`, ...), usually as a stateful fake world | `test/integration/` |
| E2E | The whole app against a real server | everything: real `createApp()`, real Mineflayer adapters, real Minecraft 1.21.1 server (Paper in Docker) | nothing (the world is prepared and inspected through RCON; a second bot or RCON simulates the player) | `test/e2e/` |

Rules:

- All code is written to be testable: constructor injection, no global state, no direct `Date.now()`/`Math.random()`/`setTimeout` outside injected `Clock`/`Random`, no Mineflayer imports outside thin adapters.
- Adapters in `src/bot/` are unit-tested against a small stub of the Mineflayer API (event emitter plus the few methods used).
- Every bug found in the game gets a regression test at the lowest tier that reproduces it.
- Coverage gate: 90% lines/branches on `src/` (excluding only the trivial `src/index.ts` entry), enforced from Phase 1 on unit and integration tests. E2E tests do not count toward coverage.
- E2E scope: a small smoke-level set per phase, not exhaustive. Behavior details belong in unit and integration tests; e2e proves the real bot works against a real server.
- E2E prerequisites: Docker running locally. One server container per run, scenarios isolated by area and reset through RCON.
- E2E tests are excluded from `npm test`, so the fast loop stays fast. They are grouped per feature (`test/e2e/<feature>/`): while working on a phase you run only its own feature group, never the accumulated earlier groups. The complete suite (`test:e2e:all`) runs at the final gate in the hardening phase and before any `release/*` merge into `main`. Unit and integration tests are cheap, so they are always run in full.

## Git workflow

Git Flow, with `main` as production and `development` as the integration branch.

- `main`: production only. Updated by release merges, tagged `vX.Y.Z`.
- `development`: integration branch. All work starts here and returns here.
- `feature/<name>`: one per phase or feature, created from `development` (for example `feature/movement-perception`; names describe the feature and never contain phase numbers), merged back into `development` with `--no-ff` once tests pass and the phase's manual check is done.
- `release/<version>`: cut from `development`, merged into `main` (tagged) and back into `development`. The complete test suite, including `test:e2e:all`, must be green on the release branch.
- `hotfix/<name>`: cut from `main` for urgent production fixes, merged into `main` and `development`.
- Conventional Commit messages (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`).
- No direct commits to `main` or `development` (apart from the one-time repository bootstrap in Phase 0).
- Merging into `development` happens after your approval of the phase; merging into `main` only on your explicit request.

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
