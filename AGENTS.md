# AGENTS.md

Guidance for AI agents (and humans) working on this repository, plus the runtime protocol for the agent that plays through it.

## Project summary

TypeScript MCP server (stdio) wrapping a Mineflayer bot. Target: Minecraft Java **1.21.1**, Node **22+**, survival play (gather, craft, build, discover structures) with an AI co-player. See [README.md](README.md) and [DEVELOPMENT-PLAN.md](DEVELOPMENT-PLAN.md).

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
3. **No blocking tool calls longer than the timeout budget.** Long work runs as a task; tools return a task result or a "still running" status (see Tasks).
4. **Reflexes must not depend on the agent.** Survival behavior is plain code and must work with no MCP client attached.
5. **Validate all external input** (env, tool arguments, chat) with zod at the boundary.
6. **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`, no `any` (use `unknown` and narrow).
7. **All code must be testable.** Inject dependencies through constructors, inject `Clock` and `Random` (no direct `Date.now()`, `Math.random()`, or bare timers in logic), keep wiring in `createApp()`, and keep Mineflayer behind thin adapters. If something is hard to test, fix the design, not the test.
8. **Follow Git Flow** (see below). Never commit directly to `main` or `development`.
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
  skills/               Behaviors: movement, gathering, crafting, hunting, storage, building, discovery
  reflexes/             ReflexEngine (priority arbitration, task pausing/resuming) and the reflexes: AvoidLava, Drowning, ThreatResponse (threat policy table), AutoEat
  tasks/                TaskManager: one active task, cancellation, progress, timeouts
  state/                FileStateStore, WorldRegistry (fingerprint matching), WorldStateManager, NotesStore, InstructionLog, StandingInstructions, TaskJournal, SessionBriefingBuilder
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
| `EntityScanner` | nearby entities (nearest first), player lookup (online, visible, position) |
| `InventoryReader` | snapshot of the bot inventory (stacks, free slots, held item) |
| `Digger` | dig block, collect drops |
| `Eater` / `FoodCatalog` | eat an item (takes it in hand, then consumes); food points and saturation of items |
| `Locomotion` | direct body controls (hold jump to swim up) |
| `Combatant` | equip the best weapon and armor; chase and hit an entity in time slices, respecting the 1.21 attack cooldown |
| `Placer` | place block against a reference face |
| `Crafter` | recipes, craft, smelt |
| `InventoryReader` / `InventoryWriter` | contents, equip, toss/drop |
| `ContainerAccess` | open chest/barrel/shulker, read contents, move items in and out |
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

### Threat policy

`ThreatResponse` is driven by a data table (`mob type → action`), not by `if` chains, so policy changes do not touch the reflex code (Open/Closed).

| Rule | Action |
|---|---|
| Health at or below `LOW_HEALTH_THRESHOLD` (default 8 of 20) | **Flee from everything**, overrides all rules below |
| `skeleton` (all variants that shoot), `creeper` | **Flee**, always |
| `enderman` | **Ignore**: never attack, never provoke |
| Any other hostile mob (zombie, spider, husk, drowned, witch, ...) | **Fight**: equip best weapon and armor, engage in melee |
| Unlisted bosses and extreme threats (`warden`, `wither`, `ender_dragon`, `elder_guardian`) | **Flee** (safety default, editable in the table) |

Fleeing means sprinting away until the threat is out of range and out of sight, preferring the direction of the owner or a known landmark. Fighting stops and flips to fleeing as soon as health drops to the threshold.

### Survival reflexes

- `ReflexEngine` ticks every 250 ms while the bot is connected (started on `connected`, stopped on disconnect or shutdown) and needs no MCP client. Each tick it reads the vitals and nearby entities once, and lets the most important reflex that `wants` to act run. A running reflex is aborted when it stops wanting to act, when the bot leaves the world, or when a strictly more important one wants in.
- Priorities: `avoid_lava` 100, `drowning` 90, `threat_response` 80, `auto_eat` 20. A reflex with `preemptsTask` (everything except eating) first **suspends** the running task (`TaskManager.suspend()`, cancel reason `preempted`, the resume descriptor is remembered). When no reflex wants to act any more the engine **resumes** it through its resume descriptor, unless a reflex in that episode said `resumeTask: false` (fleeing: running back towards the danger would be wrong). Then the agent gets an event telling it to ask the player. The owner's `stop` or a new task discards the suspended one.
- While a reflex is acting, `TaskLauncher` refuses to start tasks (they would fight the reflex for the pathfinder); the error says which reflex is acting.
- Every reflex tells the agent what it did (`type: "reflex"` events in `wait_for_chat`, also recorded in the history log).
- **Reflex loops must never spin.** If a step can return without waiting (nothing to do, no path), await `context.sleep(ms)` (it resolves early on abort, including when the signal is already aborted).
- The threat policy is a data table in `src/reflexes/threat-policy.ts` (`MOB_RULES`); `assess()` is a pure function. Fighting is done in 1-second slices through `Combatant`, re-assessing between slices, so a fight turns into fleeing as soon as health drops to the threshold.
- Combat uses `setGoal(null)`-style stopping like movement (see the pathfinder gotcha above). Attack timing per weapon lives in `src/bot/gear.ts`.
- **Deferred:** a fall-damage guard (water-bucket landing) and a night shelter. The pathfinder's default maximum drop already avoids large falls.

### Tasks

- The `TaskManager` (also the default `StopHandler`) runs **one** active task at a time. Starting a new one requires cancelling or queueing the current one explicitly.
- Every task gets an `AbortSignal`; skills must check it between steps and inside loops.
- Task-running tools take `wait_seconds` (0 to 55; `goto` defaults to 30, `follow_player` to 2) and `replace` (cancel the running task first; without it a running task blocks new ones). When the wait runs out they return `{ status: "running", taskId, progress }`; the agent polls with `get_task_status` and can `cancel_task` or `stop`. Failures carry a machine-friendly `reason` (`unreachable`, `stuck`, `timeout`, `target_not_found`, `block_not_found`, ...). Tools launch tasks through the shared `TaskLauncher`.
- Movement is supervised by `NavigationRunner`: it stops the bot on abort, gives up on timeout (30 s plus 1.5 s per block), on being stuck (no 0.75-block progress for 8 s), or when a followed player is out of view for 10 s. The safe movement profile never digs or builds and avoids lava.
- Mineflayer gotcha: halt the pathfinder with `setGoal(null)`, never with its `stop()`. `stop()` only sets a flag that is honored at the next path node, and when the bot is idle the flag lingers and makes the next `goto` fail at once with "Path was stopped" (found in a live test; regression tests cover it).
- Reflexes can pause/preempt a task and resume it after; they emit events into the event log.

### Persistent state

- Everything worth remembering is saved per world profile under `DATA_DIR/<profile>/` (`notes.json`, `history.json`, `standing-instructions.json`, `journal.json`), and the list of worlds in `DATA_DIR/worlds.json`. Files are `{ "version": n, "data": ... }`, written atomically (temp file, then rename), batched (500 ms), with the previous copy kept as `.bak`. A corrupt file is set aside as `.corrupt` and the backup (or empty defaults) is used, with a warning in the session briefing.
- **World identification.** After joining, the `WorldIdentifier` builds a fingerprint from the hashed seed (captured from the login packet in `src/bot/mineflayer-bot-factory.ts`, since Mineflayer does not expose it), the spawn point, and the world name (server status message of the day). `matchScore` decides: a matching seed is worth 2 (enough alone), spawn point and name 1 each; different seeds are certainly different worlds. No match creates a profile named after the world; several equal matches or no usable signal at all leave the world unresolved (the briefing tells the agent to ask the player and call `set_world_profile`). `connect(profile)` and `WORLD_PROFILE` are only fallbacks for that case.
- Each per-world component implements `ProfileScoped` (`attach(store)` / `detach()`); `WorldStateManager` activates them on connect and closes them (flushing) on disconnect. `close()` is safe to call concurrently and every caller waits for the same flush: a shutdown must never outrun a disconnect's write.
- **Task journal.** `TaskManager` emits start/progress/finish events; `TaskJournal` records them as jobs. Tasks are `interrupted` when they were still running after a crash, or cancelled with reason `disconnected` or `shutdown`; a deliberate stop or a replacement is just `cancelled`. Tasks that can be restarted carry a `resume` descriptor (tool plus arguments); `resume_interrupted_task` calls that tool. Nothing resumes on its own.
- The history log records the owner's chat, events, and every non-read-only tool call (`HISTORY_IGNORED_TOOLS` lists what is skipped), bounded to 300 entries.

### Chat and events

- `ChatRouter` receives every chat message: it drops messages from anyone but `MC_OWNER` (when set, case-insensitive), runs fixed commands in code (`stop`, as `ChatCommand` implementations) and turns them into an event, and gives everything else to the `AgentInbox`.
- `AgentInbox` buffers chat and events (bounded, oldest dropped, drops counted) and exposes `wait(timeoutMs, signal)`. Delivery is once-only.
- Connection changes, and later reflex and task events (`ate food`, `fled from creeper`, `task finished`), go into the same inbox and are returned together with chat by `wait_for_chat`, so the agent sees what happened while it was thinking.

## MCP tool surface (target)

Naming: `snake_case`, verbs first. Descriptions must be written for an LLM reader: state what the tool does, its units, and its failure modes.

| Group | Tools |
|---|---|
| Session | `connect`, `disconnect`, `get_status`, `get_session_briefing` |
| State | `list_worlds`, `set_world_profile`, `resume_interrupted_task`, `discard_interrupted_task`, `get_recent_history`, `remember`, `recall`, `forget`, `set_standing_instruction`, `remove_standing_instruction` |
| Chat | `wait_for_chat`, `say`, `whisper` |
| Perception | `look_around`, `find_blocks`, `get_inventory`, `get_nearby_entities`, `get_player_position` |
| Movement | `goto`, `follow_player`, `stop` |
| Gathering | `collect_block`, `pickup_items` |
| Crafting | `craft`, `smelt`, `list_recipes` |
| Hunting | `hunt_animals`, `list_huntable_animals`, `attack_entity`, `set_food_policy` |
| Handover | `give_items`, `drop_items`, `resolve_item` |
| Drop recovery | `set_drop_recovery_policy`, `skip_drop_recovery`, `recover_drops`, `list_death_records` |
| Storage | `register_container`, `label_container`, `list_containers`, `scan_containers`, `set_storage_rule`, `list_storage_rules`, `remove_storage_rule`, `deposit_items`, `withdraw_items`, `find_items`, `set_storage_policy` |
| Building | `build`, `list_blueprints`, `place_block` |
| Discovery | `explore_for_structure`, `list_known_structures`, `set_landmark`, `list_landmarks` |
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
  - Files are `test/e2e/<feature>/*.e2e.test.ts`. Helpers live in `test/e2e/support/`: `E2EWorld` (RCON: fill, setblock, give, summon, tp, positions, item counts), `joinAsPlayer` (a second real Mineflayer bot playing the human), `startApp` (the real app plus an in-memory MCP client), `startSession` (one test's clean arena, owner bot, and app bot), `waitUntil`, and `serverLog`.
  - The server is one container per run, configured by `docker/e2e-server.env` and `docker/config/bukkit.yml` (also usable by hand: `docker compose -f docker/docker-compose.e2e.yml up`). The server log is kept in `.e2e/server.log` for inspecting failures.
  - **Changes made through RCON (blocks, mobs, teleports) reach the bot a moment later.** Never act on them at once: retry a tool call until the bot's own view matches (`untilBotSees` pattern), or the test is flaky.
  - Use unique bot names per test, and keep the login throttle disabled (Paper rejects quick repeated logins from one IP with "Connection throttled").
  - Keep `SPAWN_ANIMALS=true` and `SPAWN_MONSTERS=true` in the server config (with `false` the server removes summoned animals and hostile mobs); stop natural spawning with the `doMobSpawning` game rule and clear the arena instead. The server runs on peaceful, so a test that needs hostile mobs sets the difficulty itself through RCON (and puts it back).
  - The Jest global setup/teardown are plain `.mjs` files because Jest loads them through Node's own loader, which cannot resolve `.js` imports to `.ts`. Jest also ignores `testTimeout` inside a project, so the timeout is set in `test/e2e/support/jest-setup.ts`.
- **E2E run policy:** e2e tests are grouped per feature. While developing a phase, run **only that feature's own e2e folder**, not the accumulated earlier ones. The complete e2e suite (`test:e2e:all`) is run once after all primary phases (final gate) and before any release merge into `main`. Unit and integration tests are cheap and always run in full.
- **Manual in-game check:** a human step at the end of each phase using the checklist in DEVELOPMENT-PLAN.md, with the real game client and your LAN world. It complements the automated tiers.
- Write tests with the code, in the same branch. Cover success, failure, abort, and boundary cases; tests must be deterministic (fake clock, seeded/fake random, no real sleeps, no network).
- Coverage gate: 90% lines/branches on `src/` (excluding only the trivial `src/index.ts`), measured on unit and integration tests.
- Any bug found in the game gets a regression test at the lowest tier that reproduces it.

## Git workflow (Git Flow)

- `main` is **production**. `development` is the **integration** branch.
- **Every development phase or feature gets its own branch created from `development`**: `feature/<name>`, e.g. `feature/movement-perception`. **Name branches, folders, and files after the feature, never after a development-plan phase number.** Merge back into `development` with `--no-ff` when tests pass and the user approves.
- Releases: `release/<version>` from `development`, merged into `main` (tagged `vX.Y.Z`) and back into `development`. Urgent fixes: `hotfix/<name>` from `main`, merged into `main` and `development`.
- Before starting work: `git switch development && git pull --ff-only` (if a remote exists), then `git switch -c feature/<name>`.
- Conventional Commit messages: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`.
- Do not merge into `main`, push, or force-push without an explicit request from the user.

## Runtime protocol (for the agent playing through this server)

1. Call `connect` (with the port the user gives you, or none when the world is opened to LAN); its reply includes the **session briefing**. Read it and tell the user in chat what you found: which saved world this is, how long ago it was last joined, interrupted tasks, standing instructions, and your notes. Follow `nextSteps`. If the world was not identified, ask the user what to call it and call `set_world_profile` (nothing is saved until then). Never resume an interrupted task on your own: ask first, then `resume_interrupted_task` or `discard_interrupted_task`. Then confirm with `say`.
2. Save durable context as you learn it: call `remember` for plans, builds, and user preferences that should survive a relaunch, and `set_standing_instruction` when the user gives a rule for how to behave from now on (then follow it without asking again). Do not rely on your own session memory.
3. Enter the listening loop: call `wait_for_chat` (timeout ~30 s). On timeout, call it again. Do not stop looping unless the user says to stop playing.
4. For each instruction: acknowledge briefly in chat, run the needed tools, report the result in chat. For long tasks, check `get_task_status` and send short progress updates.
5. Prefer coarse tools (`collect_block`, `build`) over many small calls. Do not micro-manage movement.
6. If a request is ambiguous or risky (destroying player builds, going far, lava), ask in chat first.
7. Never grief: do not break blocks inside player-built structures unless asked. Respect landmarks marked as protected.
8. Hunting: use `list_huntable_animals` before large hunts. Never attack tamed or named animals, and keep the breeding-pair floor unless the user overrides it. When food is low and no instruction covers it, ask the user; if they said "hunt when you run out of food", set `set_food_policy` as a standing instruction and do not ask again.
9. Storage: when the user points at a chest or describes what belongs where, register it (`register_container`, `set_storage_rule`) and confirm in chat. When a task pauses with a `needs_decision` event (for example inventory full), ask the user in chat and pass the answer to `resume_task`. If the user's instruction already allows it ("bring resources to the home chest when there is no space"), set `on_inventory_full` on the call or `set_storage_policy` as a standing instruction and do not ask again. Never empty containers marked protected.
10. Handover: when the user asks for items, call `give_items` (it fetches from inventory, then chests). If the phrase is ambiguous (for example "wood"), ask which item; if the tool reports a `shortfall`, tell the user what is missing and offer to gather, craft, or hunt it. Do not give away reserved items (current tools, armor, food) unless explicitly asked, and prefer chest mode for large amounts.
11. Drop recovery: when a `bot_died` event arrives, tell the user where it happened. Recovery runs automatically by default; if the user says to leave it, call `skip_drop_recovery` and give them the coordinates. If recovery pauses with a hazard `needs_decision`, explain the risk and ask; never send the bot into lava or void on your own.
12. Survival reflexes act on their own (eating, fighting, running away, getting out of lava, surfacing for air); do not duplicate them. They report through `reflex` events in `wait_for_chat`: tell the player briefly what happened. A reflex may pause your task and resume it afterwards. When an event says a task "was not resumed" (the bot ran away, so going back would be dangerous), ask the player whether to try again. While a reflex is acting, starting a task fails with a message naming it: wait a few seconds and retry. "Hungry but nothing safe to eat" means the player should be told, and food gathered or hunted if they agree.

## Definition of done for a change

- `npm run typecheck`, `npm run lint`, and `npm test` pass.
- New behavior has unit tests against fakes and, where modules interact, integration tests. Coverage gate passes.
- User-facing behavior (new or changed tool or reflex) has a smoke-level e2e scenario, and that feature's own e2e folder passes before merging into `development` (from the e2e-harness feature on). Do not run the full e2e suite per phase; it is reserved for the final gate and releases.
- The work is on a `feature/*` branch created from `development`.
- New tool: has zod schema, LLM-oriented description, registered in the composition root, listed in the tool table above.
- No Mineflayer imports outside `src/bot/`; no stdout writes.
- README/plan updated if behavior or configuration changed.
