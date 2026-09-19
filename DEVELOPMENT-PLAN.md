# Development Plan

Goal: a Mineflayer-based MCP server so Claude can play survival Minecraft 1.21.1 with the user: gather, craft, build, discover structures, following in-game chat instructions. Architecture rules are in [AGENTS.md](AGENTS.md).

## Decisions (fixed)

| Topic | Decision |
|---|---|
| Language | TypeScript (strict), ESM, Node 22+ |
| Minecraft | 1.21.1 vanilla, LAN world from TLauncher, bot in offline auth |
| Transport | MCP over stdio, `@modelcontextprotocol/sdk` |
| Config | `.env`: `MC_HOST=localhost` (default), `MC_PORT` (optional: when empty the port is discovered from the LAN world broadcast), plus the variables listed in README. The `connect` tool can override host/port at runtime |
| Instruction channel | In-game chat → `ChatRouter` → `AgentInbox` → agent long-polls `wait_for_chat` |
| Real-time behavior | Static-code reflexes (eat, flee, lava, drowning, `stop`); the agent only issues high-level goals |
| Threat policy | Always flee from skeletons and creepers; always flee at low health; fight all other hostile mobs (zombies, spiders, etc.); ignore endermen. Encoded as a data table, see AGENTS.md |
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
| 0 Feasibility spike | done, merged into `development` |
| 1 Project scaffold | done, merged into `development` |
| 2 Core skeleton and MCP shell | done, merged into `development` |
| 3 Movement and perception | done, merged into `development` |
| 4 E2E test harness | done, merged into `development` |
| 5 Persistent state | implemented on `feature/persistent-state`, awaiting approval |
| 6 and later | not started |

## Phases

Each phase ends with working, tested software and a manual check in the game. Estimates are rough working-session counts.

Every phase (and any later feature) is developed in its own branch created from `development` (see [Git workflow](#git-workflow)). Every phase includes its own unit and integration tests, and from the e2e-harness feature onward also e2e scenarios for its user-facing behavior. While working on a phase, run **only that phase's own e2e tests** (not the ones from earlier phases); a phase is done when its unit, integration, and own e2e tests pass. The complete e2e suite is run once at the end (see the final gate in the hardening phase).

### Phase 0: Feasibility spike (½ session)

Branch: `feature/feasibility-spike`. Throwaway script (removed after the scaffold; it lives in git history), not part of the architecture and not covered by tests.

- Repository bootstrap first: initial commit with the docs on `main`, then create `development` from it.
- Bare Mineflayer bot joins the LAN world (1.21.1, offline) and echoes your chat back.
- Confirm: connection works, chat events arrive, bot can walk to you with `mineflayer-pathfinder`.
- Probe world-identity signals available to the client: hashed seed in the login packet, the server status/MOTD (world name), the LAN broadcast (which may also reveal the port automatically), world spawn point, dimension. Record which of them are stable across re-opening the same world.
- **Exit criteria:** the bot is visible in the world and replies to chat. If not, switch to the Paper fallback.

### Phase 1: Project scaffold (½ session)

- Branch: `feature/project-scaffold`.
- `package.json` (ESM, scripts), `tsconfig.json` (strict), eslint + prettier, Jest, `.gitignore`, `.env.example`.
- Jest setup: `jest.config.ts` for TypeScript + ESM (run through `node --experimental-vm-modules`), `.js`-extension module mapping, `@jest/globals` imports, separate unit and integration projects, coverage thresholds. Scripts: `test`, `test:unit`, `test:integration`, `test:coverage`.
- Test helpers: `test/fakes/` (fake `Clock`, `Random`, `Logger`) and a builder/factory convention for test data.
- `src/config/env.ts`: zod-validated env (`MC_HOST` default `localhost`, `MC_PORT`, `MC_VERSION`, `MC_USERNAME`, `MC_AUTH`, `MC_OWNER`, `MC_AUTO_CONNECT`, `DATA_DIR`, `LOG_LEVEL`).
- `Logger` port with a stderr implementation; lint rule against `console.log`.
- `CLAUDE.md` containing `@AGENTS.md` so Claude Code picks up the rules (already created).
- **Tests:**
  - unit: env schema (defaults, required `MC_PORT`, invalid values), stderr logger (never writes to stdout)
  - integration: `createApp()` with the config and fake ports builds without side effects
- **Exit criteria:** `typecheck`, `lint`, `test` pass on an empty-but-wired project; coverage gate is active.

### Phase 2: Core skeleton and MCP shell (1 session)

- `src/core`: port interfaces (`Connection`, `ChatPort`, `VitalsReader`, `Clock`, `Logger`) and shared types (`Position`, `Result`).
- `src/bot`: `MineflayerConnection` (connect/disconnect/reconnect events, error handling) and chat adapter.
- `src/chat`: `AgentInbox` (chat and events, `wait(timeout, signal)`, bounded buffer), `ChatRouter` (owner filtering, then fixed commands, then inbox), `StopCommand`.
- `src/bot`: `LanDiscovery` port and adapter (listens to the LAN broadcast on `224.0.2.60:4445`, returns the port and world name; used by `connect` when `MC_PORT` is not set).
- `src/mcp`: `ToolRegistry`, `ToolDefinition`, server bootstrap; tools `connect`, `disconnect`, `get_status`, `wait_for_chat`, `say`, `whisper`.
- Wiring in `src/app.ts` (`createApp(config, deps)`), so it can be built in tests with fakes; `src/index.ts` only reads env, calls `createApp`, and starts the stdio transport.
- Branch: `feature/core-mcp-shell`.
- **Tests:**
  - unit: `AgentInbox` (ordering, bounded buffer, owner filter, timeout, concurrent waiters), `ChatRouter`, `StopCommand`, `ToolRegistry`, each tool's input validation and output mapping, `MineflayerConnection` and chat adapter against a stub Mineflayer bot (event emitter)
  - integration: real MCP server and client connected through the SDK's in-memory transport, real `AgentInbox`/`ToolRegistry`, fake `Connection`/`ChatPort`: `connect` → incoming chat → `wait_for_chat` → `say`
- **Exit criteria:** register the server in Claude Code; Claude connects, says hello in game, and answers a chat message through the `wait_for_chat` loop.

### Phase 3: Movement and perception (1 session)

- Ports: `Navigator`, `BlockScanner`, `EntityScanner`. Adapters over pathfinder and Mineflayer.
- `Navigator` features: goto position/player/block, follow, stop, stuck detection, timeouts, safe movement profile (no digging through player builds, no lava).
- `TaskManager` (single active task, abort, progress, bounded wait) and `get_task_status` / `cancel_task`.
- Tools: `goto`, `follow_player`, `stop`, `look_around`, `find_blocks`, `get_nearby_entities`, `get_player_position`, `get_inventory`.
- Branch: `feature/movement-perception`.
- **Tests:**
  - unit: `TaskManager` (single active task, cancel, abort propagation, progress, timeout, bounded wait returning `running`), movement skills against a fake `Navigator` (success, unreachable, stuck, aborted), perception summaries against fake scanners
  - integration: chat "stop" → interceptor → `TaskManager` cancels a running fake-navigator task; `goto` over the wait budget returns `running`, then `get_task_status` reports completion (with a fake `Clock`)
- **Exit criteria:** "come here", "follow me", and "stop" work from in-game chat; a `goto` beyond the wait budget returns `running` and completes later.

### Phase 4: E2E test harness (1 session)

- Branch: `feature/e2e-harness`.
- `docker/` with the server configuration (image `itzg/minecraft-server`, `TYPE=PAPER`, `VERSION=1.21.1`, `ONLINE_MODE=FALSE`, `EULA=TRUE`, RCON on, superflat world, `SPAWN_PROTECTION=0`, `DIFFICULTY` and `doMobSpawning` set per suite).
- Jest `e2e` project with a global setup/teardown that starts one server container for the whole run (`testcontainers`, random mapped ports, wait for the "Done" log line) and tears it down after; server and bot logs are attached to failures.
- `test/e2e/support/`: `E2EWorld` helper over RCON (`fill`, `setblock`, `give`, `clear`, `summon`, `kill`, `tp`, `time set`, `gamerule`, block/entity/inventory assertions), a helper that creates the real app via `createApp()` pointed at the container, and an MCP test client to call tools like the agent would.
- Per-test isolation: each test uses its own coordinates, resets the area, inventory, and mobs through RCON before running, and cleans up after.
- E2E tests are grouped by feature in `test/e2e/<feature>/` (for example `movement-perception/`, `survival-reflexes/`), never named with phase numbers. Scripts: `test:e2e -- <feature-dir>` runs only that feature's tests, and `test:e2e:all` runs the complete suite. Neither is part of `npm test`; there is no coverage gate; a clear failure message when Docker is unavailable.
- **Tests (the first e2e scenarios, covering Phases 2 and 3):**
  - the bot connects to the real server, appears in the player list, `say` shows up in the server log, and a chat message sent through RCON `tellraw`/a second bot reaches `wait_for_chat`
  - `goto` to coordinates and `follow_player` (player simulated by a second Mineflayer bot or RCON `tp`), and `stop` interrupts a running move
- **Exit criteria:** running only `test/e2e/movement-perception` starts the server, passes the smoke scenarios, and cleans up the container; the phase's tests are reliable across 5 consecutive runs.

### Phase 5: Persistent state (1.5 sessions)

- Branch: `feature/persistent-state`.
- Ports: `StateStore` (load/save versioned JSON documents by key), `WorldIdentifier` (produces a world fingerprint from the connection). Implementation: `FileStateStore` with atomic write (temp file + rename), a backup copy, schema versions with migrations, debounced writes, flush on shutdown, and a fallback to empty state with a warning when a file is corrupt.
- **World profiles.** Data lives under `DATA_DIR/<profile>/`. On connect, `WorldIdentifier` builds a fingerprint from whatever signals the spike showed to be stable (candidates: hashed seed, world name from the MOTD, world spawn point, dimension). Resolution order:
  1. fingerprint matches a stored profile → use it automatically
  2. no match and no stored profiles → create a profile named after the detected world name (or a generated one) and store the fingerprint
  3. ambiguous or no usable signals → fall back to the name given by the user (`WORLD_PROFILE` or `connect(profile)`); if none was given, the session briefing asks the agent to ask you
  Tools: `list_worlds`, `set_world_profile`.
- **Task journal** (`TaskJournal`, built on `TaskManager` events): records each task's tool, parameters, status, and progress checkpoints. After a relaunch, unfinished tasks appear as `interrupted` with their progress. Tool `resume_interrupted_task` (and `discard_interrupted_task`); nothing resumes automatically because the world may have changed.
- **Standing instructions:** policies and settings set through tools (threat overrides, storage policy later) are stored and restored per profile.
- **Instruction and event log:** append-only JSON lines of your chat instructions, tool calls with results, and reflex events; bounded and rotated. Tool: `get_recent_history`.
- **Agent notes:** `remember`, `recall`, `forget`: free-text notes with optional tags (for example "house plan", "player prefers oak", "base is at ..."), independent of the Claude session.
- **Session briefing:** `connect` (and `get_session_briefing`) returns the resolved world profile, time since the last session, interrupted tasks, standing instructions, key landmarks, recent history, and notes. The runtime protocol requires the agent to read it first and tell you in chat what it found.
- Later features (reflexes' overrides, storage, discovery) build on `StateStore`; the `WorldKnowledgeStore` is a thin domain layer over it.
- **Tests:**
  - unit: `FileStateStore` (atomic write, backup recovery, corrupt file, migration, debounce and flush), world profile resolution (match, new world, ambiguous, no signals, name fallback), `TaskJournal` (checkpoints, interrupted detection), history rotation, notes CRUD, briefing composition, all with a fake `Clock` and an in-memory or temp-dir store
  - integration: run a task, "kill" the app, create a new app instance on the same temp directory: the task is listed as `interrupted`, standing instructions and notes are restored, the briefing is correct; two profiles stay isolated; a different fingerprint does not load the old profile
  - e2e: connect to the Docker server, save a landmark and a note, restart the app, reconnect to the same world (fingerprint match, no name given) and get the same briefing; a re-created world with a different seed gets a new profile
- **Exit criteria:** after relaunching the MCP server and reconnecting to the same LAN world, the briefing shows the previous session; an unfinished task is offered for resume, and a different world does not see the old world's data.

### Phase 6: Survival reflexes (1 session)

- Reflex engine: priority arbitration, preemption/resume of the current task, event log.
- Reflexes: `AutoEat`, `ThreatResponse`, `AvoidLava`, `Drowning` (surface for air), `FallDamageGuard`, `NightShelter` (optional, later).
- Port: `Combatant` (attack an entity respecting the 1.21 attack cooldown, equip best weapon and armor, retreat). `ThreatResponse` and, later, hunting both use it.
- `ThreatResponse` follows the threat policy table in AGENTS.md: flee from skeletons and creepers, flee whenever health is at or below a threshold (default 8 of 20, env-configurable), fight every other hostile mob (equip best weapon and armor first), ignore endermen (never attack them). Fleeing means sprinting away until the threat is out of range and out of sight, preferring the direction of the owner or a known landmark.
- Event log integrated into `wait_for_chat` output.
- Branch: `feature/survival-reflexes`.
- **Tests:**
  - unit: each reflex against fake `VitalsReader`, `EntityScanner`, `Navigator`; `ThreatResponse` policy table exhaustively (skeleton/creeper flee, low health flee overrides fight, zombie/spider fight, enderman ignored, boss flee, threshold boundary); reflex engine arbitration by priority
  - integration: reflex preempts a running task and resumes it; events end up in the next `wait_for_chat`; reflexes work with no MCP client attached
  - e2e: zombie summoned nearby is fought and killed; creeper and skeleton summoned nearby are fled from; hunger set via RCON triggers eating; enderman is not attacked; low health triggers fleeing
- **Exit criteria:** with no MCP client attached, the bot eats when hungry, avoids lava, and reacts to a zombie; events appear in the next `wait_for_chat`.

### Phase 7: Gathering, crafting, smelting (1.5 sessions)

- Ports: `Digger`, `InventoryReader/Writer`, `Crafter`.
- Skills: `CollectBlocks` (find, path, dig, pick up drops, tool selection; own implementation, cancellable via `AbortSignal`, honors protected areas, returns typed failure reasons), `PickupItems`, `CraftItem` (recipe resolution with automatic sub-crafts, crafting table placement when needed), `SmeltItems` (furnace placement, fuel handling).
- Tools: `collect_block`, `pickup_items`, `craft`, `smelt`, `list_recipes`.
- Safety: refuse to dig protected areas; avoid digging straight down; when the inventory is full, stop with a typed, resumable `inventory_full` state (remembering where to continue); the policy for what to do next (ask, or offload and return) is implemented in the storage phase.
- Branch: `feature/gather-craft-smelt`.
- **Tests:**
  - unit: `CollectBlocks` against fake `BlockScanner`/`Navigator`/`Digger` (found, none nearby, unreachable, no suitable tool, inventory full, protected area, abort mid-way, partial result), recipe resolution and sub-craft planning against fixed recipe data, smelting fuel logic
  - integration: `collect_block` → `craft` chain through the MCP tool layer with a stateful fake world (inventory changes), including cancellation
  - e2e: collect N logs from a prepared tree, craft planks/table/pickaxe, mine ore with the right tool and smelt it; cancellation mid-collect
- **Exit criteria:** from chat, "get 20 logs", "make a wooden pickaxe", "get 10 iron ore and smelt it" complete end to end.

### Phase 8: Hunting and food (1 session)

The tools before this phase cannot hunt: perception can list entities and the reflexes only fight hostile mobs on their own, so there is no way to attack a specific passive animal, chase it, and collect the drops. This phase adds that flow.

- Branch: `feature/hunting`.
- Reuses: `Combatant` (survival reflexes phase), `Navigator` and `EntityScanner` (movement phase), `PickupItems` and `SmeltItems` (gathering phase).
- `AnimalCatalog` (data table): species → drops and behavior notes (cow: beef and leather, pig: porkchop, sheep: mutton and wool, chicken: chicken and feathers, rabbit: rabbit meat, rabbit hide, and others), plus protection rules that exclude:
  - tamed animals (owner set), animals with a custom name, leashed animals, saddled or ridden animals
  - villagers, iron golems, bees, and other neutral or non-livestock mobs
  - animals inside pens or fences (heuristic: enclosed area near player-built blocks) unless the user says so
  - the last breeding pair per species within the search area (`keep_breeders`, on by default); baby animals are skipped by default
- `HuntAnimals` skill: input is a species list or a target item and quantity (for example 20 raw beef or 10 leather), search radius, time limit, `keep_breeders`, and `cook`. Loop: find candidates → pick the nearest reachable one → approach (animals wander and flee, so re-path with a chase limit and give up on unreachable targets across water or cliffs) → equip the best weapon (sword, then axe, then bare hands) → attack in time with the 1.21 attack cooldown → pick up drops → repeat until the goal is met, no candidates are left, or the time limit is reached. Hostile mobs and low health are handled by the reflexes, which preempt and then resume the hunt.
- `cook: true`: after hunting, run the existing smelting skill on raw meat (furnace, smoker, or campfire when available; fuel handling included); with the storage feature present, cooked food can be deposited according to the storage rules (food category).
- **Low-food policy** (`LowFoodPolicy`, same pattern as the inventory-full policy): when food runs low and the inventory has nothing edible, the bot pauses or emits a `needs_decision` event; options are `ask` (default), `hunt_and_cook` (allowed by the user's instruction on the call or as a standing instruction), and `stop`. Works together with the `AutoEat` reflex, which keeps eating whatever food exists.
- Tools: `hunt_animals`, `list_huntable_animals` (what is around and what is protected), `attack_entity` (explicit single target, for requests like "kill that cow"; refuses protected animals unless overridden), `set_food_policy`.
- Safety: never harm pets or named animals; report species counts before and after; stop when the breeding-pair floor is reached and tell the user.
- **Tests:**
  - unit: `AnimalCatalog` (each protection rule, baby animals, breeding-pair floor), `HuntAnimals` against fake `EntityScanner`/`Navigator`/`Combatant` (nearest-first selection, chase give-up, attack cooldown timing with a fake clock, drop pickup, goal reached by item counts, no candidates, time limit, abort, hostile interruption), `LowFoodPolicy` (ask, hunt_and_cook, stop)
  - integration: hunt → smelt → (deposit) chain through the tool layer on a stateful fake world; a hostile appears mid-hunt, the reflex preempts, the hunt resumes; a low-food task pauses with `needs_decision` and continues after `resume_task`
  - e2e: cows, pigs, sheep and chickens summoned in an area via RCON, `hunt_animals` for N raw beef ends with the items in the inventory; a named cow and a tamed wolf are never attacked; the last breeding pair is preserved; `cook: true` yields cooked meat; with no food and no instruction the bot asks
- **Exit criteria:** "get me 10 steaks" from chat runs the full flow (hunt, drops, cook); protected animals stay unharmed; "if you run out of food, hunt" is remembered as a standing instruction and works.

### Phase 9: Storage and containers (1.5 sessions)

- Branch: `feature/storage-containers`.
- Ports: `ContainerAccess` (open chest/barrel/double chest/shulker box, read contents, move items in and out). Mineflayer adapter behind it.
- Container memory in `WorldKnowledgeStore` (persisted per world profile through `StateStore`): position, optional label (`home`, `wood`, `tools`, ...), last-seen contents, last-opened time, optional `protected` flag.
- **Pointing at chests.** A container is registered by any of: explicit coordinates, "the chest I am looking at" (the bot reads the owner's look direction and finds the targeted block), or "the nearest chest to me". Tool: `register_container` (with optional label).
- **Storage rules** (`StorageRule`): "these kinds of items go into that chest". An `ItemMatcher` supports exact item names, item tags/groups (for example all logs, all ores, all food), and categories (tools, food, blocks); rules have priorities, and a catch-all rule is allowed. Example: stone and cobblestone → chest A, ores and ingots → chest B, everything else → chest C. Tools: `set_storage_rule`, `list_storage_rules`, `remove_storage_rule`.
- **Target selection** (`ContainerSelector`, swappable strategy): first matching rule wins; if no rule matches, use any known chest with free space (nearest first), then any unknown nearby chest; if none has room, report `no_storage_space` (optionally craft and place a new chest when allowed by the instruction).
- **Skills:** `DepositItems`, `WithdrawItems`, `FindItems` (search the remembered index first, then open nearby chests to refresh it, and report where an item is), `ScanContainers` (refresh the index), optional `OrganizeStorage` (sort everything according to the rules). Reserve list: tools, weapons, armor, food, and torches are never deposited unless asked.
- **Inventory-full policy** (`InventoryFullPolicy`), used by gathering and any other inventory-filling task:
  - `ask` (default when the user gave no instruction): the task **pauses** in a `waiting_for_input` state (not failed), emits a `needs_decision` event (delivered through `wait_for_chat`), and I ask you in chat; the answer goes back via `resume_task`.
  - `offload_and_return`: allowed by your instruction, either on the call (`on_inventory_full`) or as a standing instruction for the session (`set_storage_policy`, for example "feel free to bring resources to the home chest iteratively when there is no space left"). The task remembers its position, walks to the target container chosen by the rules, deposits, walks back, and continues. Limits: max trips, max distance, stop conditions (`no_storage_space` → falls back to `ask`).
  - `stop`: end the task with the partial result.
  - Long-task flows such as "gather 100 stacks of stone and build a house from it, bring resources to the home chest whenever there is no space" are composed by the agent from these primitives: `collect_block` with the offload policy, then `build`, with a standing policy carried across the steps.
- `TaskManager` gains the `waiting_for_input` state and pause/resume; tools `resume_task` and `set_storage_policy`, plus the container tools: `deposit_items`, `withdraw_items`, `find_items`, `list_containers`, `label_container`, `register_container`, `scan_containers`.
- Hunting integration: `hunt_animals` with `cook: true` can deposit the cooked food into the chest designated by the food rule, and the inventory-full policy applies to hunts as well.
- Building integration (in the building phase): `build` reports missing materials and can fetch them from the container index when the policy allows.
- Safety: never take from or empty containers marked `protected`; report what was moved; handle full, missing, and destroyed containers gracefully (the index is refreshed on mismatch).
- **Tests:**
  - unit: `ItemMatcher` (names, tags, categories, precedence), `ContainerSelector` (rules, fallback to any chest, no space), deposit/withdraw against a fake `ContainerAccess` (partial fits, full chest, double chest, missing item), `InventoryFullPolicy` (ask vs offload vs stop, trip limit, fallback), `TaskManager` pause/resume, container index persistence
  - integration: gather task hits inventory-full → pauses and emits `needs_decision` → `resume_task` continues; with `offload_and_return` it makes several deposit trips without asking and finishes the whole quantity; rules route different item kinds to different chests; `WorldKnowledgeStore` on a temp directory keeps containers and rules across app restarts
  - e2e: fill chests via RCON and `find_items` locates the item across several chests; deposit routes stone, ores, and misc to three different chests by rule; a gather task with a small inventory (filled via RCON) completes through repeated offload trips; without instruction the task pauses and asks
- **Exit criteria:** "these chests hold those items" rules are remembered across restarts; "get all my iron from the chests" finds it; the flow "gather N stacks of stone, offload to the home chest when full, then continue" runs end to end, and the same flow without instruction asks first.

### Phase 10: Item handover (½ session)

Today there is no way to hand items over: the inventory port can drop items, but no tool exposes it, and nothing walks to a player, chooses what to give, or fetches it from storage. This phase adds that flow.

- Branch: `feature/item-handover`.
- Reuses: `Navigator` (go to the player), `InventoryReader/Writer` (toss), and the storage feature (`FindItems`, `WithdrawItems`) as the source of items.
- `ItemResolver`: turns what you say ("iron", "some wood", "a stack of cobble", "food") into concrete item ids and counts, using minecraft-data names, plurals, and item groups. When the request is ambiguous ("wood" could be logs or planks) it returns candidates so that I ask you in chat. Counts like "a stack" or "all" are supported.
- `GiveItems` skill: input is the player (defaults to the owner), the items, and options (`fetch_from_storage`, default on; `keep_reserve`, default on; `mode`).
  1. Source: take from the inventory first, then from remembered chests (walks there, withdraws, returns), then report a typed `shortfall` with exactly what is missing so that the agent can offer to gather, craft, or hunt.
  2. Reserve: tools in use, armor, weapons, and food are not given unless named explicitly.
  3. Delivery: find the player (they may be far away; go to them, and report if they are in another dimension or unloaded), approach to about 2 to 3 blocks, face the player, and toss the items so they land at the player's feet, splitting into stacks with a short delay. Check that the drop spot is safe (not lava, water, or a ledge).
  4. Aftercare: step back so the bot does not re-collect its own drop right away, and verify the dropped item entities disappear (were picked up). What happens to items nobody picks up is decided by the drop-recovery feature (next phase): by default the bot collects them back after a timeout, unless the user said to leave them.
  5. `mode: chest`: for large amounts (many stacks), put the items in a chosen or nearby chest instead, and tell the player which one.
- Tools: `give_items`, `drop_items` (drop at the bot's own position, for example to get rid of junk; respects the reserve), and `resolve_item` (shows what a phrase maps to). The reverse direction, you giving items to the bot, needs no new tool: you drop them near it and `pickup_items` collects them.
- Safety: only the configured owner's requests count as instructions (`MC_OWNER`); never give items that are marked reserved or come from `protected` containers without confirmation; report exactly what was given.
- **Tests:**
  - unit: `ItemResolver` (names, plurals, groups, "a stack", "all", ambiguity candidates), `GiveItems` against fake `Navigator`/`InventoryWriter`/storage ports (source order inventory then chests, shortfall report, reserve rules, stack splitting, approach distance, unsafe drop spot, pickup verification and retry, player gone or in another dimension, abort)
  - integration: "give me 3 stacks of cobblestone" through the tool layer on a stateful fake world with items split between inventory and a chest; shortfall returns the missing counts; chest mode
  - e2e: a second Mineflayer bot acts as the player (its inventory is inspectable): `give_items` delivers the requested items; items fetched from a chest filled via RCON; shortfall case; reserved tools are not given; chest mode with many stacks
- **Exit criteria:** "give me 20 iron ingots" from chat makes the bot fetch them from the inventory or chests, walk to you, and drop them at your feet; you receive them, and if they are not enough the bot tells you exactly what is missing.

### Phase 11: Drop recovery (1 session)

The plan had no death handling at all, and nothing about items the bot has dropped that end up lying around. This phase makes recovering the bot's own drops automatic by default, and skippable whenever you ask.

- Branch: `feature/drop-recovery`.
- Two situations covered:
  1. **Death drop:** the bot died and its inventory lies at the death spot (items despawn after 5 minutes).
  2. **Unclaimed handover drop:** items dropped for a player that nobody picked up.
- `DropRecoveryPolicy`: `auto` (default) or `skip`. Set as a standing instruction (`set_drop_recovery_policy`, optionally per situation), or per call (`give_items(recollect_unclaimed: false)`), or told in chat at any moment ("forget it, do not go for it"), which calls `skip_drop_recovery`: any running recovery is cancelled, and the record is kept as `abandoned` with coordinates so you can fetch it yourself. Skipped or abandoned drops can be recovered later on request (`recover_drops`).
- Even in `auto`, the bot never wades into lava, void, or other hazards: when the spot looks unsafe it pauses in `waiting_for_input` with a `needs_decision` event and reasons, and I ask you.
- `DeathReflex` (a reflex in the existing reflex engine): detects death, respawns, and records a `DeathRecord` (position, dimension, time, cause, snapshot of the inventory before death, so it knows what was lost), saved through `StateStore` so it survives a relaunch. Emits a `bot_died` event and a chat message with the coordinates. If keepInventory is on, no recovery is needed and it is skipped.
- `RecoverDrops` skill:
  - hazard assessment of the death spot from a safe staging point (lava, void, deep water, fire, cacti, hostile mobs, wrong dimension), then approach with the safe movement profile
  - deadline: death time + 5 minutes minus a safety margin; if the ETA exceeds it, say so instead of trying
  - pick up all item entities around the spot (drops scatter), then re-equip armor, weapon, tools, and shield
  - report recovered versus lost items (from the pre-death snapshot)
  - max attempts (default 2) so it cannot loop into repeated deaths
- Unclaimed handover drops: after the pickup-verification timeout (default 60 s), with `auto` the bot collects the leftover items and tells the player; with `skip` (or `recollect_unclaimed: false`) it leaves them.
- `DropIgnoreList`: items the bot deliberately dropped (for example junk via `drop_items`) are never auto-recollected.
- Tools: `set_drop_recovery_policy`, `skip_drop_recovery`, `recover_drops`, `list_death_records`.
- **Tests:**
  - unit: `DeathReflex` (record contents, keepInventory case, persistence), `RecoverDrops` against fake scanners and navigator (hazard detected → asks, deadline math with a fake clock, max attempts, partial recovery report, re-equip), policy handling (auto, skip, cancel a running recovery, recover later), ignore list, unclaimed-drop logic
  - integration: bot dies → record persisted → app restarted → record still there and recovery proceeds or is offered; skipping mid-recovery cancels it and reports the coordinates; unclaimed handover drop is recollected in `auto` and left in `skip`
  - e2e: the bot holding items is killed through RCON, respawns, and recovers its items automatically; "skip" leaves them and reports the coordinates; a death spot surrounded by lava (built via RCON) leads to asking and not to a second death; an unclaimed handover drop is collected back after the timeout, and left when `recollect_unclaimed` is false
- **Exit criteria:** after the bot dies, it tells you where and recovers its stuff by itself; telling it to skip stops the attempt and gives you the coordinates; a dangerous spot is never entered without asking you.

### Phase 12: Building (1.5 sessions)

- Port: `Placer`. Domain: `Blueprint` (relative block placements), `BlueprintProvider` registry.
- Providers: `Box`/`Walls`/`Floor`, `Shelter` (1×2 emergency), `SmallHouse`, plus a JSON blueprint loader for custom builds.
- `BuildSkill`: material requirement calculation, missing-materials report (so the agent can gather first), layer-by-layer placement, scaffolding (pillar up) for elevated placement, verification pass, retry of failed blocks.
- Tools: `build`, `list_blueprints`, `place_block`. Missing materials can be fetched from the container index (uses the storage phase's `FindItems`/`WithdrawItems`).
- Branch: `feature/building`.
- **Tests:**
  - unit: blueprint providers (deterministic output, dimensions, door position, material counts), `BuildSkill` against a fake `Placer` and a grid-based fake world (ordering, scaffolding, retries, verification pass, missing materials)
  - integration: `build` through the tool layer on a stateful fake world produces the expected block grid
  - e2e: build a small house on flat ground from supplied materials, then verify the block layout in the world through RCON; missing-materials report when the inventory is empty
- **Exit criteria:** "build a small house here" gathers or reports missing materials, then produces a complete, enterable house with a door.

### Phase 13: World discovery (1.5 sessions)

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
- **Tests:**
  - unit: each `StructureSignature` against synthetic block/entity grids (positive, negative, near-miss), exploration strategies (deterministic with a fake `Random`, no revisits, respect bounds), `ExploreForStructure` (found, time/distance limit, abort)
  - integration: `WorldKnowledgeStore` against a real temp directory (persist, reload, corrupt file handling); explore → discover → persist → new app instance still lists the structure
  - e2e: on a fixed-seed world (seed chosen so a village is within reach of spawn, ground truth confirmed with `/locate`), `explore_for_structure` finds the village within a bounded time and the coordinates are close to the truth; a pre-built signature structure placed via RCON is detected
- **Exit criteria:** "find a village" makes the bot explore and report village coordinates in chat, and that structure remains listed after restart.

### Phase 14: Hardening and polish (1 session)

- Reconnect logic and clean shutdown, timeouts on every I/O boundary, error messages written for the agent.
- Tool description review: each is short, states units and failure modes.
- Branch: `feature/hardening`.
- Tests: reconnect and shutdown behavior (unit and integration with fake `Connection`), timeouts on all I/O boundaries, coverage gap review.
  - e2e: server restart mid-session leads to reconnect; abrupt disconnect leaves no stuck task; a long-running scenario chaining gather → craft → build
- Write the "agent playbook" prompt based on real sessions; update README with tested flows.
- **Final gate (the only place the complete e2e suite is required):** run `test:e2e:all` (every phase's e2e tests together, including cross-phase scenarios) plus the full unit, integration, and coverage runs. Fix regressions found here on the `feature/hardening` branch or a dedicated `feature/*` fix branch.
- **Exit criteria:** the full test run is green; 30-minute co-play session (gather → craft → build → explore) without restarts.

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
  README.md  AGENTS.md  CLAUDE.md  DEVELOPMENT-PLAN.md
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
  docs/               # feasibility findings and other notes
  data/<profile>/     # gitignored: per-world state (knowledge, journal, notes, ...)
```

## Open items to confirm during execution

- ~~Whether the LAN world accepts the offline bot~~ Confirmed in the Phase 0 spike (see `docs/feasibility-findings.md`); Paper fallback not needed. `MC_PORT` is now optional (decided): the port and world name come from the LAN broadcast. Still open: whether the hashed seed stays the same when the world is re-opened.
- Whether Claude Code channels/Monitor can replace polling for instant chat delivery (evaluate after Phase 2; polling is the baseline).
- Low-health threshold (default 8 of 20) and flee distance; tune during Phase 6 play testing.

## Next step

Awaiting your approval of this plan. On approval I start with **Phase 0** (feasibility spike) on its own branch from `development`, then Phase 1 and onward, pausing for a manual in-game check and your approval at the end of each phase.
