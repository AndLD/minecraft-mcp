# AGENTS.md

Guidance for AI agents (and humans) working on this repository, plus the runtime protocol for the agent that plays through it.

## Project summary

TypeScript MCP server (stdio) wrapping a Mineflayer bot. Target: Minecraft Java **1.21.1**, Node **22+**, survival play (gather, craft, build, discover structures) with an AI co-player. See [README.md](README.md) and [DEVELOPMENT-PLAN.md](docs/DEVELOPMENT-PLAN/DEVELOPMENT-PLAN.md); feature documentation is indexed in [docs/features/FEATURES.md](docs/features/FEATURES.md).

## Commands

```bash
npm run dev         # run from source (tsx)
npm run build       # tsc → dist/
npm start           # run built server
npm test            # Jest: unit + integration (no Minecraft required)
npm run test:unit
npm run test:integration
npm run test:coverage
npm run test:e2e -- test/e2e/movement-perception   # e2e for ONE feature (real server in Docker; slow)
npm run test:e2e:all                            # complete e2e suite; only at the final gate / release
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
```

## Hard rules

1. **stdout belongs to the MCP protocol.** Never use `console.log` or write to stdout. Log through the `Logger` port, which writes to stderr.
2. **Never let Mineflayer types leak past `src/bot/`.** Everything else depends on ports in `src/core/`.
3. **No blocking tool calls longer than the timeout budget.** Long work runs as a task; tools return a task result or a "still running" status (see [Tasks](docs/features/core/tasks.md)).
4. **Reflexes must not depend on the agent.** Survival behavior is plain code and must work with no MCP client attached.
5. **Validate all external input** (env, tool arguments, chat) with zod at the boundary.
6. **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`, no `any` (use `unknown` and narrow).
7. **All code must be testable.** Inject dependencies through constructors, inject `Clock` and `Random` (no direct `Date.now()`, `Math.random()`, or bare timers in logic), keep wiring in `createApp()`, and keep Mineflayer behind thin adapters. If something is hard to test, fix the design, not the test.
8. **Follow Git Flow** (see below): publish every branch, merge only through pull requests, and never commit directly to `main` or `development`.
9. **Never run live tests against the operator's real LAN world without asking first.** The operator supervises the work but is often away from the computer. Before any live test (connecting the bot to their running game, scripted checks, interactive sessions), ask in chat whether they are ready and wait for a clear yes; do this every time, even if an earlier live test was approved. Unit, integration, and Docker e2e tests run against fakes or a throwaway server and need no confirmation.

## Architecture

Dependency direction: **`mcp` → `skills`/`tasks` → `core` ← `bot`**. The composition root (`src/app.ts`) is the only place that wires concrete classes together.

```
src/
  index.ts              Entry point only: read env, call createApp, start stdio transport
  app.ts                Composition root: createApp(config, deps) builds and wires everything (testable)
  infra/                Real implementations of generic ports: SystemClock, SystemRandom, StderrLogger (the only place allowed to touch Date.now, Math.random, stderr)
  config/               Env loading + zod schema (MC_HOST, MC_PORT, ...)
  core/                 Ports (interfaces) and domain types. No imports from other layers.
  bot/                  Mineflayer adapter: implements the ports (only place importing mineflayer)
  chat/                 AgentInbox (chat + events buffer with wait), ChatRouter (owner filter, fixed commands, inbox), StopCommand
  session/              SessionService: decides where to connect (request, config, LAN discovery) and connects
  perception/           Services built on scanner ports: BlockFinder (name check + suggestions), SurroundingsDescriber, notable-block table
  skills/               Behaviors: movement/, gathering/ (CollectBlocks, PickupItems, DropCollector), crafting/ (RecipePlanner, CraftItem, Workstations), smelting/ (SmeltItems, fuel and smelting tables); hunting/ (HuntAnimals, AttackEntity, AnimalCatalog, PenDetector, LowFoodResponder), storage/ (DepositItems, WithdrawItems, FindItems, ScanContainers, ContainerSelector, ContainerVisitor, InventoryFullHandler, item matcher), handover/ (GiveItems, DropItems, ItemResolver), recovery/ (RecoverDrops, DeathResponder, AutoRecovery, UnclaimedDropHandler, HazardAssessor, DropIgnoreList), commands/ (Teleport), construction/ (PlanExecutor, StandingSpotChooser, SiteSafety, WorkPlan), building/ (BuildSkill, blueprints, StorageMaterialFetcher), construction/ also has the Scaffolder and the HazardRule, excavation/ (ExcavateSkill, shapes); later discovery
  reflexes/             ReflexEngine (priority arbitration, task pausing/resuming) and the reflexes: AvoidLava, Drowning, ThreatResponse (threat policy table), AutoEat
  tasks/                TaskManager: one active task, cancellation, progress, timeouts
  state/                FileStateStore, WorldRegistry (fingerprint matching), WorldStateManager, NotesStore, InstructionLog, StandingInstructions, TaskJournal, ProtectedAreas, FoodPolicy, DropRecords, DropRecoveryPolicy, ContainerIndex, StorageRules, StoragePolicy, SessionBriefingBuilder
  knowledge/            WorldKnowledgeStore (domain layer over StateStore): persisted landmarks, discovered structures, containers, storage rules
  mcp/                  MCP server, ToolRegistry, and one file per tool
test/
  unit/                 Mirrors src/; one unit at a time, all ports faked
  integration/          Several real modules wired together; only outer ports faked
  e2e/                  Whole app against a real Minecraft server in Docker; RCON to set up and inspect the world
    <feature>/          One folder per feature (movement-perception/, survival-reflexes/, ...)
  fakes/                Fakes and builders for ports (Clock, Random, Navigator, ...)
docker/                 E2E server configuration (itzg/minecraft-server, Paper 1.21.1)
```

### Core ports (narrow on purpose)

Skills receive only the ports they need, never a whole bot.

| Port | Responsibility |
|---|---|
| `Connection` | connect / disconnect / status / lifecycle events |
| `Navigator` | go to a position or player, follow a player; every call takes an `AbortSignal` (aborting halts the bot) |
| `BlockScanner` | block names, find blocks by name (nearest first), read a block, summarize blocks around the bot |
| `EntityScanner` | nearby entities (nearest first), player lookup (online, visible, position, facing) |
| `AnimalScanner` | animals nearby with baby, name tag, owner, saddle, rider, and dead flags (read from the entity metadata); lookup by id |
| `InventoryReader` | snapshot of the bot inventory (stacks, free slots, held item) |
| `Digger` | assess a block (diggable? which tools harvest it? do we carry one?) and dig it with the best tool; aborting stops the dig |
| `DroppedItemScanner` | items lying on the ground near the bot (name, count, position) |
| `AreaGuard` | which places are protected (implemented by `ProtectedAreas`) |
| `Eater` / `FoodCatalog` | eat an item (takes it in hand, then consumes); food points and saturation of items |
| `Locomotion` | direct body controls (hold jump to swim up) |
| `Combatant` | equip the best weapon and armor; chase and hit an entity in time slices, respecting the 1.21 attack cooldown |
| `Placer` | put a block from the inventory into a free cell, against the block below it |
| `RecipeBook` / `Crafter` | recipes per item (ingredients, table needed, index) and crafting one by index and repeat count |
| `FurnaceAccess` | open a furnace: put input and fuel, take output, input, and fuel back |
| `InventoryReader` / `InventoryWriter` | contents; throw items out (`toss`) |
| `Gaze` | turn to face a point (then wait for the server to learn the direction) |
| `Sleeper` / `BedAccess` | lie down in a bed, get up, whether the bot sleeps; a bed's blockstate and right-clicking it, returning the server's reply lines |
| `RailAccess` / `MinecartPlacer` | a rail block's shape and power from its blockstate; put a minecart from the inventory on a rail |
| `ServerCommands` | which commands the server offers the bot (from its command list), and typing one (`/tp`) and reading the server's reply, classified as ok, no permission, unknown command, error, or no reply |
| `DeathWatcher` | reports each death (place, dimension, what was carried and worn, the server's message) once the bot has respawned; reads what is carried now |
| `ContainerAccess` | open a chest, barrel, or shulker box (a double chest is one container): read its contents, deposit and withdraw by item name, close |
| `ItemFacts` | what the game data says about items: exists, food, block, stack size |
| `LookTarget` | the block a player's crosshair points at, and which face was hit (for "the chest I am looking at" and "dig a room behind this wall") |
| `VitalsReader` | health, food, saturation, oxygen, in lava/water/head underwater, position, dimension, time |
| `ChatPort` | say / whisper, incoming chat stream |
| `StateStore` | load/save versioned JSON documents per world profile (atomic writes) |
| `WorldIdentifier` | fingerprint of the connected world (seed hash, name, spawn) |
| `Scheduler` | delayed callbacks (`after(ms, fn)` returns a cancel function); never call `setTimeout` in logic |
| `LanDiscovery` | listens for the LAN world announcement (port, world name, host player) |
| `Clock` / `Random` / `Logger` | time, randomness, and logging, injectable for tests |

### SOLID, concretely

- **S: single responsibility.** One class, one reason to change: `TreeCollector` gathers wood; it does not craft or navigate. Tools only translate MCP input/output; they contain no game logic.
- **O: open/closed.** New capabilities are added by new classes, not by editing switches:
  - a new MCP tool = a new file implementing `ToolDefinition`, registered in the composition root
  - a new reflex = a new `Reflex` implementation
  - a new structure to find = a new `StructureSignature`
  - a new building = a new `BlueprintProvider`
- **L: Liskov.** Any `Reflex`, `Skill`, `ExplorationStrategy`, or `BlueprintProvider` must be substitutable: honor the contract (respect `AbortSignal`, never throw for expected failures; return a typed result).
- **I: interface segregation.** Ports are small and role-based (table above). Test fakes implement only what a skill uses.
- **D: dependency inversion.** High-level modules (skills, tasks, tools) depend on `core` interfaces injected via constructors. No `new MineflayerX()` outside the composition root. No module-level singletons or global state.

### Key contracts

```ts
interface Skill<In, Out> {
  readonly name: string;
  run(input: In, ctx: SkillContext): Promise<SkillResult<Out>>;   // ctx has AbortSignal + progress reporter
}

interface Reflex {
  readonly name: string;
  readonly priority: number;               // higher wins
  shouldActivate(state: BotState): boolean;
  run(ctx: ReflexContext): Promise<void>;  // may preempt the running task
}

interface ToolDefinition<Schema extends z.ZodTypeAny> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema;
  execute(input: z.infer<Schema>): Promise<ToolResult>;
}

interface StructureSignature {           // discovery
  readonly kind: string;                 // "village" | "desert_temple" | ...
  detect(scan: BlockScanner, entities: EntityScanner): StructureHit | null;
}

interface ExplorationStrategy {          // discovery
  nextWaypoint(state: ExplorationState): Position | null;   // spiral, frontier, biome-guided
}

interface AnimalCatalog {                // hunting: what may be hunted
  isHuntable(entity: EntityInfo, ctx: HuntContext): { ok: true } | { ok: false; reason: string };  // tamed, named, baby, breeding-pair floor, ...
  drops(species: string): ItemDrop[];
}

type DropRecoveryPolicy =                 // for death drops and unclaimed handover drops
  | { kind: "auto" }                     // default: recover automatically (still asks when the spot is hazardous)
  | { kind: "skip" };                    // leave them; keep a record with coordinates

type LowFoodPolicy =                     // set per call or as a standing instruction
  | { kind: "ask" }                      // default: pause / emit needs_decision
  | { kind: "hunt_and_cook" }
  | { kind: "stop" };

interface ItemResolver {                 // handover: user words → concrete items
  resolve(phrase: string): { kind: "items"; items: ItemStack[] } | { kind: "ambiguous"; candidates: ItemCandidate[] };
}

interface ItemMatcher {                  // storage: what a rule applies to
  matches(item: ItemStack): boolean;     // exact names, tags/groups, categories
}

interface StorageRule {
  readonly containerId: string;
  readonly matcher: ItemMatcher;
  readonly priority: number;
}

interface ContainerSelector {            // storage: which container gets these items
  select(items: ItemStack[], ctx: SelectionContext): ContainerChoice;   // rules, then any chest with room
}

type InventoryFullPolicy =               // set per call or as a standing instruction
  | { kind: "ask" }                      // default: pause task, emit needs_decision, wait for resume_task
  | { kind: "offload_and_return"; maxTrips?: number; maxDistance?: number }
  | { kind: "stop" };

interface BlueprintProvider {
  readonly name: string;
  generate(params: unknown, origin: Position): Blueprint;   // list of block placements
}
```

### Feature documentation

How each feature works (design decisions, gotchas found in real runs, tests, exit criteria) lives under [docs/features/](docs/features/FEATURES.md), one file per feature. **Read the file for the feature you are about to change, and update it in the same branch as the code.** Add a new feature as a new file plus a row in the index, and record what it depends on (and update the "Used by" line of those features); a new phase gets a row in the plan's dependency table.

## MCP tool surface (target)

Naming: `snake_case`, verbs first. Descriptions must be written for an LLM reader: state what the tool does, its units, and its failure modes.

| Group | Tools |
|---|---|
| Session | `connect`, `disconnect`, `get_status`, `get_session_briefing` |
| State | `list_worlds`, `set_world_profile`, `resume_interrupted_task`, `discard_interrupted_task`, `get_recent_history`, `remember`, `recall`, `forget`, `set_standing_instruction`, `remove_standing_instruction` |
| Chat | `wait_for_chat`, `say`, `whisper` |
| Perception | `look_around`, `find_blocks`, `get_inventory`, `get_nearby_entities`, `get_player_position` |
| Movement | `goto`, `follow_player`, `stop`, `lead_player` (not built yet) |
| Autonomy | `set_autonomy`, `get_autonomy_status`, `get_will`, `set_will`, `add_goal`, `update_goal`, `remove_goal`, `list_goal_kinds`, `get_autonomy_log` (off by default; not built yet) |
| Doors | ordinary doors, gates, and trapdoors are opened by walking tools themselves (`goto`, `follow_player`, and anything else that navigates, via `DoorOpeningNavigator`; `close_doors` on `goto`); iron doors are handled by the standing `set_switch_policy` (`ask`/`auto`/`never`) plus `press_switch`, `open_door`, `find_switches` for buttons, levers, and plates |
| Gathering | `collect_block` (`layout`/`structured_threshold` for a pit or quarry instead of scattered holes on a bulk terrain request; `saplings` to also collect tree saplings, on request), `pickup_items` |
| Crafting | `craft`, `smelt`, `list_recipes` |
| Protection | `protect_area`, `unprotect_area`, `list_protected_areas` |
| Hunting | `hunt_animals`, `list_huntable_animals`, `attack_entity`, `set_food_policy` |
| Handover | `give_items`, `drop_items`, `resolve_item` |
| Drop recovery | `set_drop_recovery_policy`, `skip_drop_recovery`, `recover_drops`, `list_death_records` |
| Storage | `register_container`, `label_container`, `list_containers`, `scan_containers`, `set_storage_rule`, `list_storage_rules`, `remove_storage_rule`, `deposit_items`, `withdraw_items`, `find_items`, `set_storage_policy` |
| Building | `build`, `list_blueprints`, `place_block`, `preview_build` (blueprints: floor, walls, box, solid, block, house, shelter, custom) |
| Excavation | `excavate` (pit, shaft, quarry, tunnel, branch mine, staircase_down, room; `stair_width`/`stair_height`, `seal_caves`/`seal_block`), `preview_excavation`, `list_excavations` |
| Signs | `place_sign`, `edit_sign`, `remove_sign`, `read_signs` (not built yet) |
| Site leveling | `flatten_area`, `preview_flatten` (cut, fill, and clear a rectangle to a level) |
| Railways | `plan_railway`, `build_railway`, `place_minecart` |
| Sleeping | `sleep`, `set_respawn_point`, `place_bed`, `list_beds`, `set_sleep_policy` (never in the Nether or the End: a bed explodes there) |
| Farming | `build_farm` (field, pen), `plant_crops`, `harvest_crops`, `lure_animals`, `breed_animals`, `collect_eggs`, `set_egg_policy`, `tend_farm`, `inspect_farm`, `discover_farm`, `plant_trees`, `harvest_trees`, `collect_saplings`, `list_farms`, `register_farm` |
| Server commands | `teleport_to_player`, `teleport_to_position` (only on the player's request, and only when the server allows commands) |
| Discovery | `explore_for_structure`, `explore_caves`, `list_known_structures`, `set_landmark`, `list_landmarks` |
| Tasks | `get_task_status`, `cancel_task`, `resume_task` |

## Coding conventions

- ESM (`"type": "module"`), TypeScript `strict`, target ES2023, `moduleResolution: NodeNext`. Import local files with `.js` extensions. TypeScript is pinned to `~6.0` because `ts-jest` and `typescript-eslint` do not support 7.x yet; revisit when they do.
- Files that contain only interfaces or types are named `*.port.ts` (ports) or `*.types.ts` (data types). They emit no code and are excluded from the coverage gate; put runtime code in a differently named file.
- Lint enforces the hard rules: `no-console`, no `Date.now()`/`new Date()`/`Math.random()` outside `src/infra` and tests, no Mineflayer imports outside `src/bot`, no `any`.
- Files are `kebab-case.ts`; one exported class or interface per file when practical; interfaces are not prefixed with `I`.
- Prefer composition and constructor injection. No inheritance hierarchies deeper than one level.
- Expected failures (unreachable, out of materials, interrupted) are **values** (`{ ok: false, reason }`), not exceptions. Exceptions are for bugs and I/O errors.
- Positions are immutable value objects (`Vec3`-like, defined in `core`). Do not pass mutable Mineflayer `Vec3` across layers.
- Keep functions small; comment the *why*, not the *what*.
- Dependencies: `mineflayer`, `mineflayer-pathfinder`, `minecraft-data`, `@modelcontextprotocol/sdk`, `zod`. Add others only with a reason recorded in the plan.

## Testing

Framework: **Jest** (TypeScript, ESM, `@jest/globals`). Three automated tiers. Unit and integration run offline with no Minecraft (`npm test`); e2e runs against a real server in Docker (one feature: `npm run test:e2e -- <feature-dir>`; everything: `npm run test:e2e:all`).

- **Unit (`test/unit/`, mirrors `src/`):** one class or function at a time; all ports, `Clock`, and `Random` are fakes from `test/fakes/`. Covers skills, reflexes, task manager, chat inbox, tools, blueprints, signatures, config, and the thin Mineflayer adapters (against a stub of the Mineflayer API).
- **Integration (`test/integration/`):** several real modules wired together, faking only the outer ports (usually a stateful fake world). Examples: an MCP client talking to the real MCP server over the SDK's in-memory transport; reflex preempting a task; `WorldKnowledgeStore` on a temp directory; `createApp()` wiring.
- **E2E (`test/e2e/`):** real `createApp()` and real Mineflayer against a headless Minecraft 1.21.1 server (Paper via `itzg/minecraft-server`, `ONLINE_MODE=FALSE`) started by Jest global setup with `testcontainers`. Worlds are prepared and inspected through RCON (`E2EWorld` helper); one container per run, each test isolated by area and reset before it runs. Keep it a small smoke-level set per phase, with generous timeouts and controlled mobs and time. Requires Docker; not counted in coverage; excluded from `npm test`. On failure, dump server and bot logs.
- **E2E conventions and gotchas** (learned while building the harness):
  - Items given by RCON (`give`) reach the bot's inventory a moment later: wait until `get_inventory` shows them before calling a tool that depends on them (`untilBotCarries` in the gather-craft-smelt e2e).
  - Files are `test/e2e/<feature>/*.e2e.test.ts`. Helpers live in `test/e2e/support/`: `E2EWorld` (RCON: fill, setblock, give, summon, tp, positions, item counts), `joinAsPlayer` (a second real Mineflayer bot playing the human), `startApp` (the real app plus an in-memory MCP client), `startSession` (one test's clean arena, owner bot, and app bot), `waitUntil`, and `serverLog`.
  - The server is one container per run, configured by `docker/e2e-server.env` and `docker/config/bukkit.yml` (also usable by hand: `docker compose -f docker/docker-compose.e2e.yml up`). The server log is kept in `.e2e/server.log` for inspecting failures.
  - **Changes made through RCON (blocks, mobs, teleports) reach the bot a moment later.** Never act on them at once: retry a tool call until the bot's own view matches (`untilBotSees` pattern), or the test is flaky.
  - Use unique bot names per test, and keep the login throttle disabled (Paper rejects quick repeated logins from one IP with "Connection throttled").
  - Keep `SPAWN_ANIMALS=true` and `SPAWN_MONSTERS=true` in the server config (with `false` the server removes summoned animals and hostile mobs); stop natural spawning with the `doMobSpawning` game rule and clear the arena instead. The server runs on peaceful, so a test that needs hostile mobs sets the difficulty itself through RCON (and puts it back).
  - **Known intermittent failure (cause found, check fixed):** in `test/e2e/excavation/extras.e2e.test.ts`, the stairs test once failed 3 times in about 9 full runs on the assertion that the block under stair step 1 is dirt, then passed 6 runs in a row and 3 runs alone. The runs took the same time either way, so a sleeping machine or a stalled Docker container is unlikely; the cause is not known (a late RCON view, load, or a rare real dig bug). The check now reports which block it found, so a new failure shows the cause. If it comes back, look at that message first rather than just rerunning. **Probable cause, seen again in the railway work:** dirt that has open air above it turns into grass by itself (grass spreads onto it), so "the block under step 1 is dirt" can read `grass_block` a few seconds after the dig; it failed once in a regression run for the railway branch with exactly that message and passed three reruns. The check now accepts `grass_block` as well as `dirt`.
  - The Jest global setup/teardown are plain `.mjs` files because Jest loads them through Node's own loader, which cannot resolve `.js` imports to `.ts`. Jest also ignores `testTimeout` inside a project, so the timeout is set in `test/e2e/support/jest-setup.ts`.
- **E2E run policy:** e2e tests are grouped per feature. While developing a phase, run **only that feature's own e2e folder**, not the accumulated earlier ones. The complete e2e suite (`test:e2e:all`) is run once after all primary phases (final gate) and before any release merge into `main`. Unit and integration tests are cheap and always run in full.
- **Manual in-game check:** a human step at the end of each phase using the checklist in [DEVELOPMENT-PLAN.md](docs/DEVELOPMENT-PLAN/DEVELOPMENT-PLAN.md), with the real game client and your LAN world. It complements the automated tiers.
- Write tests with the code, in the same branch. Cover success, failure, abort, and boundary cases; tests must be deterministic (fake clock, seeded/fake random, no real sleeps, no network).
- Coverage gate: 90% lines/branches on `src/` (excluding only the trivial `src/index.ts`), measured on unit and integration tests.
- Any bug found in the game gets a regression test at the lowest tier that reproduces it.

## Git workflow (Git Flow)

- `main` is **production**. `development` is the **integration** branch.
- **Every development phase or feature gets its own branch created from `development`**: `feature/<name>`, e.g. `feature/movement-perception`. **Name branches, folders, and files after the feature, never after a development-plan phase number.** Merge back into `development` through a pull request (merge commit) when tests pass and the user approves.
- Releases: `release/<version>` from `development`, merged into `main` (tagged `vX.Y.Z`) and back into `development`. Urgent fixes: `hotfix/<name>` from `main`, merged into `main` and `development`.
- Before starting work: `git switch development && git pull --ff-only` (if a remote exists), then `git switch -c feature/<name>`.
- Conventional Commit messages: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`.
- **Every branch is published to the remote** (`git push -u origin <branch>`) as soon as it is created; never leave a branch local-only. This includes `development`.
- **Every merge goes through a pull request** on GitHub (`gh pr create --base <target>`, then `gh pr merge --merge` for a merge commit), never a local `git merge` into `development` or `main`. The user's approval is still required before merging.
- **Do not delete a branch after its PR merges.** Merge with `gh pr merge --merge` (no `--delete-branch`) and leave the branch on the remote as history.
- Do not merge into `main` or force-push without an explicit request from the user.

## Runtime protocol (for the agent playing through this server)

A ready-to-paste start prompt for this protocol is in [docs/agent-start-prompt.md](docs/agent-start-prompt.md); keep it in step with the list below.

1. Call `connect` (with the port the user gives you, or none when the world is opened to LAN); its reply includes the **session briefing**. Read it and tell the user in chat what you found: which saved world this is, how long ago it was last joined, interrupted tasks, standing instructions, and your notes. Follow `nextSteps`. If the world was not identified, ask the user what to call it and call `set_world_profile` (nothing is saved until then). Never resume an interrupted task on your own: ask first, then `resume_interrupted_task` or `discard_interrupted_task`. Then confirm with `say`.
2. Save durable context as you learn it: call `remember` for plans, builds, and user preferences that should survive a relaunch, and `set_standing_instruction` when the user gives a rule for how to behave from now on (then follow it without asking again). Do not rely on your own session memory.
3. Enter the listening loop: call `wait_for_chat` (timeout ~30 s). On timeout, call it again. Do not stop looping unless the user says to stop playing.
4. For each instruction: acknowledge briefly in chat, run the needed tools, report the result in chat. For long tasks, check `get_task_status` and send short progress updates.
5. Prefer coarse tools (`collect_block`, `build`) over many small calls. Do not micro-manage movement.
6. If a request is ambiguous or risky (destroying player builds, going far, lava), ask in chat first.
7. Never grief: do not break blocks inside player-built structures unless asked. Respect landmarks marked as protected.
8. Hunting: use `list_huntable_animals` before large hunts, and hunt with `hunt_animals` ("get me 10 steaks" is `item: cooked_beef, count: 10`). Never attack tamed or named animals, and keep the breeding-pair floor unless the user overrides it (when it stops with `breeding_floor`, tell the user the herd is at its minimum and offer to override). A `needs_decision` event about food means the bot is hungry with nothing to eat: ask the user; if they say to hunt whenever food runs out, call `set_food_policy` with `hunt_and_cook` and do not ask again.
9. Storage: when the user points at a chest or describes what belongs where, register it (`register_container` by coordinates, `looking_at` after asking them to look at it, or `nearest`; give it a label) and set rules (`set_storage_rule` with item names or groups such as ores and ingots), and confirm in chat. When a task pauses (`waiting_for_input`, announced by a `needs_decision` event; `get_task_status` shows `waitingFor`), ask the user in chat and pass their answer to `resume_task`. To answer "where is my iron?" use `find_items`; to fetch it, `withdraw_items`; `protect` chests the player wants left alone with `label_container` (`protected: true`). If the user's instruction already allows it ("bring resources to the home chest when there is no space"), set `on_inventory_full` on the call or `set_storage_policy` as a standing instruction and do not ask again. Never empty containers marked protected.
10. Handover: when the user asks for items ("give me 20 iron ingots", "3 stacks of cobble"), call `give_items` with the item words as they said them (it fetches from the inventory, then chests). If it fails with `ambiguous` (for example "iron" or "wood"), ask which of the listed candidates; `resolve_item` shows what words mean beforehand. When the result has a `shortfall`, tell the user exactly what is missing and offer to gather, craft, or hunt it. If `unclaimed` is not empty, tell them the items lie on the ground near where the bot stood. The bot keeps its own tools, armor, food, and torches out of requests by group; naming an item exactly gives it. Prefer `mode: chest` for many stacks. `drop_items` is for getting rid of junk, not for giving things to the player.
11. Drop recovery: when a `bot_died` event arrives, tell the user where it happened (the bot also says it in chat). Recovery runs automatically by default and reports through `drop_recovery` events; if the user says to leave it, call `skip_drop_recovery` and give them the coordinates, and if they say to never go back for the bot's things, call `set_drop_recovery_policy` with `skip`. If recovery pauses with a hazard `needs_decision`, explain the risk and ask, then pass `try_carefully` or `abandon` to `resume_task`; never send the bot into lava or void on your own. A `bot_died` event that says the bot died while recovering means it will not go back by itself: ask before calling `recover_drops` again (it needs a higher `max_attempts`). Items thrown for a player that nobody picks up are taken back after a minute unless `recollect_unclaimed` is false; the session briefing lists `pendingDrops` after a restart: tell the player and ask before fetching them.
12. Survival reflexes act on their own (eating, fighting, running away, getting out of lava, surfacing for air); do not duplicate them. They report through `reflex` events in `wait_for_chat`: tell the player briefly what happened. A reflex may pause your task and resume it afterwards. When an event says a task "was not resumed" (the bot ran away, so going back would be dangerous), ask the player whether to try again. While a reflex is acting, starting a task fails with a message naming it: wait a few seconds and retry. "Hungry but nothing safe to eat" means the player should be told, and food gathered or hunted if they agree.
13. Gathering and crafting: ask for what the player wants in blocks (`collect_block` counts blocks broken, so ores and stone give different items; check `gained` in the result). Use `list_recipes` when unsure what an item needs. When a tool fails, act on the reason: `no_suitable_tool` names what to craft first (a pickaxe of that tier), `missing_materials` lists exactly what to gather, `inventory_full` means free space (or ask, until the storage phase handles it) and call again for the remainder in the message, `protected_area` means do not force it. Before working near a player build, call `protect_area` for it (ask the player for the corners or use their position) and never `unprotect_area` unless they say so. `craft` and `smelt` use, place, or craft a crafting table and furnace by themselves; they stay where they were placed.

## Definition of done for a change

- `npm run typecheck`, `npm run lint`, and `npm test` pass.
- New behavior has unit tests against fakes and, where modules interact, integration tests. Coverage gate passes.
- User-facing behavior (new or changed tool or reflex) has a smoke-level e2e scenario, and that feature's own e2e folder passes before merging into `development` (from the e2e-harness feature on). (run policy: see Testing).
- The work follows the Git workflow above (feature branch, published, merged through a PR).
- New tool: has zod schema, LLM-oriented description, registered in the composition root, listed in the tool table above.
- The hard rules hold (lint checks most of them).
- README/plan updated if behavior or configuration changed.