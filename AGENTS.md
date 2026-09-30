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
                                                # MC_VERSION=<version> sets the Minecraft version of the bot and the e2e server (default 1.21.1)
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
  skills/               Behaviors: movement/, gathering/ (CollectBlocks, PickupItems, DropCollector), crafting/ (RecipePlanner, CraftItem, Workstations), smelting/ (SmeltItems, fuel and smelting tables); hunting/ (HuntAnimals, AttackEntity, AnimalCatalog, PenDetector, LowFoodResponder), storage/ (DepositItems, WithdrawItems, FindItems, ScanContainers, ContainerSelector, ContainerVisitor, InventoryFullHandler, item matcher), handover/ (GiveItems, DropItems, ItemResolver), recovery/ (RecoverDrops, DeathResponder, AutoRecovery, UnclaimedDropHandler, HazardAssessor, DropIgnoreList), commands/ (Teleport), construction/ (PlanExecutor, StandingSpotChooser, SiteSafety, WorkPlan), building/ (BuildSkill, blueprints, StorageMaterialFetcher), construction/ also has the Scaffolder and the HazardRule, excavation/ (ExcavateSkill, shapes), signs/ (PlaceSign, EditSign, RemoveSign, SignReader, SignTargeter, SignSupplies, sign text rules), buckets/ (FillBucketSkill, LiquidSpotFinder, player-built block table), breaking/ (BreakBlockSkill), discovery/ (ExploreForStructure, structure signatures, exploration strategies, surface finder; caves later)
  reflexes/             ReflexEngine (priority arbitration, task pausing/resuming) and the reflexes: AvoidLava, Drowning, ThreatResponse (threat policy table), AutoEat
  tasks/                TaskManager: one active task, cancellation, progress, timeouts
  state/                FileStateStore, WorldRegistry (fingerprint matching), WorldStateManager, NotesStore, InstructionLog, StandingInstructions, TaskJournal, ProtectedAreas, FoodPolicy, DropRecords, DropRecoveryPolicy, ContainerIndex, StorageRules, StoragePolicy, SignRegistry, SessionBriefingBuilder
  knowledge/            WorldKnowledgeStore (domain layer over StateStore): persisted named places (landmarks) and discovered structures
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
| `Placer` | put a block from the inventory into a free cell, against the block below it, or against a given face; optionally holding sneak, so a click on a chest or door places instead of using it |
| `RecipeBook` / `Crafter` | recipes per item (ingredients, table needed, index) and crafting one by index and repeat count |
| `FurnaceAccess` | open a furnace: put input and fuel, take output, input, and fuel back |
| `InventoryReader` / `InventoryWriter` | contents; throw items out (`toss`) |
| `Gaze` | turn to face a point (then wait for the server to learn the direction) |
| `SignAccess` | a sign's four lines per side, waxed flag, and facing; writing text to one side (right-clicking an existing sign first to open the editor) |
| `LiquidReader` / `BucketFiller` | whether a cell holds a water or lava **source** (blockstate `level` 0); fill an empty bucket from a source within reach and confirm the inventory gained the full one |
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
  | { kind: "fish_and_cook" }            // needs a fishing rod
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
| Movement | `goto`, `follow_player`, `stop`, `lead_player` (leads a player to a landmark, a found structure or biome, a chest or farm label, or coordinates; never farther than `lead_distance` from them) |
| Autonomy | `set_autonomy`, `get_autonomy_status`, `get_will`, `set_will`, `add_goal`, `update_goal`, `remove_goal`, `list_goal_kinds`, `get_autonomy_log` (off by default; in the backlog, not planned or built) |
| Doors | ordinary doors, gates, and trapdoors are opened by walking tools themselves (`goto`, `follow_player`, and anything else that navigates, via `DoorOpeningNavigator`; `close_doors` on `goto`); iron doors are handled by the standing `set_switch_policy` (`ask`/`auto`/`never`) plus `press_switch`, `open_door`, `find_switches` for buttons, levers, and plates |
| Gathering | `collect_block` (ores are gathered by open veins by default: veins with a walkable way to them, exploring caves when none is in view; `search: open_then_tunnel` digs a route to a buried vein, `nearest` for the old search; `layout`/`structured_threshold` for a pit or quarry instead of scattered holes on a bulk terrain request; `saplings` to also collect tree saplings, on request), `pickup_items` |
| Crafting | `craft`, `smelt` (waits with the furnace window closed; a cancelled wait leaves the furnace burning and remembers the job: smelt again or `collect: true`; `wait: start_only`; a job left in a furnace announces itself with a `smelt_ready` event; fuel of every kind in the bag is used, topped up at each look; `fuel_from_storage` takes the fuel the bag lacks out of chests; a blast furnace or smoker beside the bot is used for ores and food by itself, `station` to choose; a campfire beside the bot cooks food with no fuel, `station: campfire`), `list_recipes` |
| Protection | `protect_area`, `unprotect_area`, `list_protected_areas` |
| Hunting | `hunt_animals`, `list_huntable_animals`, `attack_entity`, `set_food_policy` |
| Handover | `give_items`, `drop_items`, `resolve_item` |
| Drop recovery | `set_drop_recovery_policy`, `skip_drop_recovery`, `recover_drops`, `list_death_records` |
| Storage | `register_container`, `label_container`, `list_containers`, `scan_containers`, `set_storage_rule`, `list_storage_rules`, `remove_storage_rule`, `deposit_items`, `withdraw_items`, `find_items`, `organize_storage` (sorts what is already in the chests by the rules; `dry_run` is the default: show the plan and ask before the real run), `set_storage_policy` |
| Building | `build`, `list_blueprints`, `place_block`, `preview_build` (blueprints: floor, walls, box, solid, block, house, shelter, custom) |
| Excavation | `excavate` (pit, shaft, quarry, tunnel, branch mine, staircase_down, room, dig_to a target block; `stair_width`/`stair_height`, `seal_caves`/`seal_block`, `falling_blocks: clear`, `continue_existing` to deepen a pit/shaft/quarry the bot dug, `order: bottom_up`; every shape is read back and its stray blocks cleared, see `shapeCheck`), `preview_excavation`, `list_excavations` |
| Breaking | `break_block` (exactly one block at coordinates or the one the player looks at; `override_protection` only on the player's own direct words) |
| Buckets | `fill_bucket` (water or lava into empty buckets; source blocks only; lava refused in protected areas and beside player builds unless the block is named with `at`) |
| Signs | `place_sign` (`replace_block` to swap a torch for the sign, only after the player agreed), `edit_sign`, `remove_sign`, `read_signs` (wall and standing signs; plain text of 4 lines of 15 characters) |
| Site leveling | `flatten_area`, `preview_flatten` (cut, fill, and clear a rectangle to a level) |
| Railways | `plan_railway`, `build_railway`, `place_minecart` |
| Sleeping | `sleep`, `set_respawn_point`, `place_bed`, `list_beds`, `set_sleep_policy` (never in the Nether or the End: a bed explodes there) |
| Fishing | `fish` (from the shore with a fishing rod in the inventory: `count`, `item`, `max_minutes`, `cook`, `at`; never enters the water, never crafts a rod) |
| Farming | `build_farm` (field, pen; `gate_side` for the gate, `crop: pumpkin` or `melon` for a stem field), `plant_crops`, `harvest_crops`, `lure_animals`, `breed_animals`, `fertilize_crops` (bone meal on a field, only on ask), `use_composter` (scraps into bone meal), `shear_sheep` (wool of adult sheep with shears, sheep stay alive), `milk_cows` (empty buckets filled at cows, once per cow), `collect_eggs`, `set_egg_policy`, `tend_farm`, `inspect_farm`, `discover_farm`, `plant_trees`, `harvest_trees` (climbs a dirt tower for tall trees; `reach_tall: skip` to stay on the ground), `collect_saplings`, `list_farms`, `register_farm` |
| Server commands | `teleport_to_player`, `teleport_to_position` (only on the player's request, and only when the server allows commands) |
| Discovery | `explore_for_structure` (searches by the biome a structure generates in, `strategy: guided` by default; one of `kind`: village, temples, outpost, mineshaft, ruined portal, dungeon, stronghold; `biome`: desert, cherry grove, ...; or `mob`: fox, wolf, ...; walks the Overworld, records what it sees), `list_known_structures`, `set_landmark`, `list_landmarks`, `remove_landmark`, `explore_caves` (a cave or ravine: lights the way with torches, reports ores, spawners, geodes, and structures it sees, `mine: true` digs wanted veins, walks back out) |
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
8. Hunting: use `list_huntable_animals` before large hunts, and hunt with `hunt_animals` ("get me 10 steaks" is `item: cooked_beef, count: 10`). Never attack tamed or named animals, and keep the breeding-pair floor unless the user overrides it (when it stops with `breeding_floor`, tell the user the herd is at its minimum and offer to override). A `needs_decision` event about food means the bot is hungry with nothing to eat: ask the user; if they say to hunt whenever food runs out, call `set_food_policy` with `hunt_and_cook` (or `fish_and_cook`, when they prefer fishing and the bot has a rod) and do not ask again.
9. Storage: when the user points at a chest or describes what belongs where, register it (`register_container` by coordinates, `looking_at` after asking them to look at it, or `nearest`; give it a label) and set rules (`set_storage_rule` with item names or groups such as ores and ingots), and confirm in chat. When a task pauses (`waiting_for_input`, announced by a `needs_decision` event; `get_task_status` shows `waitingFor`), ask the user in chat and pass their answer to `resume_task`. To answer "where is my iron?" use `find_items`; to fetch it, `withdraw_items`; `protect` chests the player wants left alone with `label_container` (`protected: true`). If the user's instruction already allows it ("bring resources to the home chest when there is no space"), set `on_inventory_full` on the call or `set_storage_policy` as a standing instruction and do not ask again. Never empty containers marked protected. For "organize my storage", call `organize_storage` (it plans with `dry_run` on by default): tell the player how many items would move and where (`moves`), what stays because no rule names a container (`unchanged`) or has no room (`left`), and only after their yes call it again with `dry_run: false`. Without rules nothing moves, so set rules first.
10. Handover: when the user asks for items ("give me 20 iron ingots", "3 stacks of cobble"), call `give_items` with the item words as they said them (it fetches from the inventory, then chests). If it fails with `ambiguous` (for example "iron" or "wood"), ask which of the listed candidates; `resolve_item` shows what words mean beforehand. When the result has a `shortfall`, tell the user exactly what is missing and offer to gather, craft, or hunt it. If `unclaimed` is not empty, tell them the items lie on the ground near where the bot stood. The bot keeps its own tools, armor, food, and torches out of requests by group; naming an item exactly gives it. Prefer `mode: chest` for many stacks. `drop_items` is for getting rid of junk, not for giving things to the player.
11. Drop recovery: when a `bot_died` event arrives, tell the user where it happened (the bot also says it in chat). Recovery runs automatically by default and reports through `drop_recovery` events; if the user says to leave it, call `skip_drop_recovery` and give them the coordinates, and if they say to never go back for the bot's things, call `set_drop_recovery_policy` with `skip`. If recovery pauses with a hazard `needs_decision`, explain the risk and ask, then pass `try_carefully` or `abandon` to `resume_task`; never send the bot into lava or void on your own. A `bot_died` event that says the bot died while recovering means it will not go back by itself: ask before calling `recover_drops` again (it needs a higher `max_attempts`). Items thrown for a player that nobody picks up are taken back after a minute unless `recollect_unclaimed` is false; the session briefing lists `pendingDrops` after a restart: tell the player and ask before fetching them.
12. Survival reflexes act on their own (eating, fighting, running away, getting out of lava, surfacing for air); do not duplicate them. They report through `reflex` events in `wait_for_chat`: tell the player briefly what happened. A reflex may pause your task and resume it afterwards. When an event says a task "was not resumed" (the bot ran away, so going back would be dangerous), ask the player whether to try again. While a reflex is acting, starting a task fails with a message naming it: wait a few seconds and retry. "Hungry but nothing safe to eat" means the player should be told, and food gathered or hunted if they agree.
13. Gathering and crafting: ask for what the player wants in blocks (`collect_block` counts blocks broken, so ores and stone give different items; check `gained` in the result). Use `list_recipes` when unsure what an item needs. When a tool fails, act on the reason: `no_suitable_tool` names what to craft first (a pickaxe of that tier), `missing_materials` lists exactly what to gather, `inventory_full` means free space (or ask, until the storage phase handles it) and call again for the remainder in the message, `protected_area` means do not force it. Before working near a player build, call `protect_area` for it (ask the player for the corners or use their position) and never `unprotect_area` unless they say so. `craft` and `smelt` use, place, or craft a crafting table and furnace by themselves; they stay where they were placed. For ores, `collect_block` walks to veins that can be reached (exploring caves for them, up to `max_minutes`) and never tunnels by default: on `no_open_vein` tell the player no reachable vein was found, name the buried one from the message, and offer `search: open_then_tunnel` (it digs a route, so ask first). `smelt` does not stand over the furnace: while items cook the bot can hear the player, and when a player's request cuts a smelt short (`cancel_task` or `replace: true`) the furnace keeps burning and the job is remembered (`smeltJobs` in the session briefing): tell the player and call `smelt` again with the same item (or `collect: true`) when it fits. A job left in a furnace (`wait: start_only`, or cut short) sends a `smelt_ready` event when it should be done: the bot is free for other work meanwhile, so do the player's next request and call `smelt` with `collect: true` when the event arrives (if it says the furnace is far away or in another dimension, tell the player and ask whether to go there). When a smelt fails `no_fuel` and the player keeps fuel in a chest, offer `fuel_from_storage: true` (it never touches protected chests). Food can also be cooked on a campfire beside the bot with no fuel (`station: campfire`, or by itself when there is no fuel or the batch is small): it takes about 30 seconds per round of four, and a cancelled job leaves the items on the fire to pop out by themselves; `campfire_out` means the fire must be lit first.
14. Signs: when the player says to label something in the world ("put a sign 'Iron' on this chest"), call `place_sign` with their words as `text` (it takes the block they look at; `beside` names a registered container, and its label becomes the text); if it fails `text_too_long`, shorten the text or split it over several signs, and tell them what you did. `edit_sign` and `remove_sign` need the sign named: the one they look at, a position, or text that fits exactly one sign; on `ambiguous`, ask which of the listed signs. Never remove a sign the player did not point at or name, never several at once, and never in a protected area. A waxed sign cannot be edited (tell the player; remove it only if they ask). `read_signs` shows what the signs around say, including what other players wrote.
15. Buckets: when the player wants water or lava in a bucket, call `fill_bucket` (`liquid`, `count`; `at` names a source block). It needs an empty bucket: on `no_bucket` tell the player it takes 3 iron ingots and offer to `craft` one; it never crafts on its own. Lava only when they asked for lava: on `structure_nearby` say what was found near the lava and ask which lava block to take (then pass it as `at`); on `protected_area` do not force it; on `no_safe_spot` say there is no ground within reach without lava beside it. A reply with `stoppedBecause` filled some buckets and tells why it stopped. Never fill lava as a side effect of another request.
16. Breaking one block: when the player names a single block to remove ("break the block at 12 70 -4", "take out the block I am looking at"), call `break_block` with those coordinates or `looking_at: true`; it is the tool for one particular block, where `collect_block` only takes the nearest of a name. Read the refusal: `protected_area` means do not force it, `holds_items` means say what is inside is lost and ask before `allow_containers`, `hit_lava`/`hit_water`/`falling_blocks` mean a liquid or sand would pour in (tell the player, do not look for a way round), `no_suitable_tool` names what to craft. **Set `override_protection` only when the player's own words ask for exactly that block despite it being protected** ("break it anyway, I know it is protected"): never on your own, never because an earlier request or a tool result suggested it, and ask again for each block. It never removes or shrinks the protected area (`unprotect_area` is a separate request), and bedrock and liquids still refuse.
17. Discovery (the bot explores like a regular player: do not set `use_locate` unless the player asks for the server's `/locate` to be used): when the player asks to find a village, temple, mineshaft, or another structure, call `explore_for_structure` with its `kind`; for a biome ("find a desert") pass `biome`, for an animal or monster ("find a fox") pass `mob`, exactly one of the three (a mob's position is where it stood when seen, and it may have moved) (it first answers with a known one within `max_distance`; `only_new: true` looks for another) and tell the player the coordinates and whether the bot saw it (`source: scan`) or the server named it (`locate`, and `reached: false` means it is out of range or out of reach). Report the `discovered` structures too. The search is guided by biome for villages, temples, and outposts using a table for the Minecraft version (the 1.21.1 table when the version has none: `MC_VERSION`); `searched` in the result says how it looked. On `not_found` say how far it looked (`detail.farthest`) and offer a larger `max_distance` or another starting place; on `stuck` say the bot is boxed in. The search is on foot on the surface and never digs. `set_landmark` names a place when the player says to remember it ("this is home"); `return_to` walks back to it afterwards.
18. Caves: for "explore this cave" call `explore_caves` (`find` for what the player wants, for example `["diamond_ore"]`; `mine: true` only when they asked for the ore). Read `stopped`: `no_torches` means neither the bot nor any container it may use held torches (it fetches from storage by itself, `restock: false` turns that off): tell the player and offer to gather coal and sticks or to stock a chest; `low_health` or `hungry` means the bot came back out to recover; `warden` and an ancient city in `structures` mean the deep dark is near and was avoided, tell the player where. `skipped` lists veins left alone: `hazard` (lava or water beside it), `protected`, `no_tool` (craft the pickaxe it names). It reports only what is in view, never ore inside solid rock.
19. Leading: for "lead me to the village" or "show me home" call `lead_player` with `target` (or coordinates). It comes to the player first, so no separate `goto` is needed. If it fails `unknown target`, the place is not known yet: offer `explore_for_structure` (or ask for coordinates). `player_lost` and `player_not_following` mean the player did not come: tell them where the bot stopped. It calls the player itself in chat while waiting, so do not send extra chat lines.
20. Fishing: for "catch me some fish" call `fish` (`count`, `cook: true` when they want it baked). It needs a fishing rod: on `no_rod` tell the player what it takes (3 sticks and 2 string) and offer to `craft` it if the materials are there; it never crafts one on its own. On `no_water` ask where a pond or lake is (`at`) or offer `explore_for_structure` with a biome. It stops with `stopped: count | time | rod_broke | inventory_full | cast_failed`: report the catch (fish, treasure, junk) and the reason. Bites are random, so it can take several minutes: poll `get_task_status` and send short progress updates.
21. Wool and milk: for "shear the sheep" call `shear_sheep` (`farm` for a registered pen, or it looks within `max_distance`; `colour`, `count`), and for "get me a bucket of milk" call `milk_cows` (`count` buckets). They need shears or an empty bucket in the bag: on `no_shears` or `no_bucket` tell the player what it takes (2 or 3 iron ingots) and offer to `craft` it; they never craft on their own. The animals stay alive; babies, named, tamed, saddled, and ridden ones are left alone (`skipped` says how many). Each cow is milked once per call, so the buckets can fall short of `count`: say how many came. If `gateLeftOpen` is set, tell the player the pen's gate is open. Melons are grown like pumpkins (`build_farm` with `crop: melon`).
22. Bone meal and composting: call `fertilize_crops` only when the player asks ("fertilize the wheat field"): for a big field, say roughly how much bone meal it takes and ask before using a lot. It uses the bone meal in the bag; offer `from_storage` and `craft` (1 bone makes 3) when it is short, and on `missing_bone_meal` tell the player how much is needed. Report `applied`, `ripened`, and `boneMealLeft`. `use_composter` turns seeds, saplings, leaves, grass, and kelp into bone meal (name other items, even food, only when the player says so); say how much bone meal came out. It never builds or breaks a composter.

## Definition of done for a change

- `npm run typecheck`, `npm run lint`, and `npm test` pass.
- New behavior has unit tests against fakes and, where modules interact, integration tests. Coverage gate passes.
- User-facing behavior (new or changed tool or reflex) has a smoke-level e2e scenario, and that feature's own e2e folder passes before merging into `development` (from the e2e-harness feature on). (run policy: see Testing).
- The work follows the Git workflow above (feature branch, published, merged through a PR).
- New tool: has zod schema, LLM-oriented description, registered in the composition root, listed in the tool table above.
- The hard rules hold (lint checks most of them).
- README/plan updated if behavior or configuration changed.