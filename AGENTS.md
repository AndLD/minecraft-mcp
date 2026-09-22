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
| `EntityScanner` | nearby entities (nearest first), player lookup (online, visible, position) |
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
| `ServerCommands` | which commands the server offers the bot (from its command list), and typing one (`/tp`) and reading the server's reply, classified as ok, no permission, unknown command, error, or no reply |
| `DeathWatcher` | reports each death (place, dimension, what was carried and worn, the server's message) once the bot has respawned; reads what is carried now |
| `ContainerAccess` | open a chest, barrel, or shulker box (a double chest is one container): read its contents, deposit and withdraw by item name, close |
| `ItemFacts` | what the game data says about items: exists, food, block, stack size |
| `LookTarget` | the block a player's crosshair points at (for "the chest I am looking at") |
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

### Gathering, crafting, smelting

- `CollectBlocksSkill` (`collect_block`) breaks blocks nearest first and picks up the drops. The count is **blocks broken**, not items gained (stone drops cobblestone); the result lists what the inventory gained. Group names (`logs`, `ores`, `leaves`) live in `src/skills/gathering/block-aliases.ts`. A block is only dug when open air touches it (no tunnelling), it is not directly below the bot (no pits), no lava touches it, and it is not inside a protected area. It walks to within 3 blocks, retries once from 1.5 when the dig says out of reach, and gives up after 6 blocks in a row that cannot be reached. Expected stops are typed failures with the numbers in the message and in `detail` (`mined`, `requested`, `remaining`): `block_not_found`, `no_suitable_tool` (names the tools), `inventory_full` (call again for the remainder), `protected_area`, `unreachable`, `not_reachable_without_tunnelling`, `aborted`. A resumed task (after a reflex) only collects what is still missing.
- `Digger.assess` decides tool use from the block data (`harvestTools`, `material`); `chooseTool` (`src/bot/tool-choice.ts`) is pure. A tool is only required when the block has `harvestTools`.
- `DropCollector` walks onto dropped items (each item tried once, at most 12 trips) so the game picks them up; `pickup_items` uses it too.
- `RecipePlanner` (pure, over `RecipeBook`) turns "make X" into ordered craft steps with automatic sub-crafts. Minecraft data has one recipe per wood type, so it only tries variants whose ingredients can be had (fixpoint over what is carried), best first, and backtracks on quantities; it merges neighbouring identical crafts and, when the materials fall short, reports what is missing for the oak variant. `craft` always makes `count` **more** (ignores stock of the goal item). `CraftItemSkill` places or walks to a crafting table when a step needs one, and crafts a table first when there is none anywhere. Each step is verified against the inventory and retried (3 tries) when the game ignored it.
- `SmeltItemsSkill` (`smelt`): smeltable items are our own table (`smelting-table.ts`; Minecraft data has no smelting recipes). Fuel is chosen by `chooseFuel` (charcoal, coal, sticks, planks, logs; never coal blocks, blaze rods, or lava buckets unless named; never the items being smelted). It crafts a furnace when there is none, works in batches of one stack, takes leftovers back on any exit, and times out after 10 s per item plus 30 s.
- **Gotcha found in a live session: a single starved reading of the furnace right after loading is not real "out of fuel".** A fuel item is consumed into the burn queue the instant it starts burning (the fuel slot empties at once), a moment before the server's separate burning-progress packet catches up (the same kind of stale-window read crafting and chests have); a single-item batch hits this every time, since the fuel and input finish loading almost together. Reading `burning: false` and no fuel item in that gap and believing it at once loses a log that had, in fact, just started burning (once consumed, it can no longer be taken back). The fix: the "out of fuel" reading must survive one full poll (`POLL_MS`, 1 s) before it is believed.
- **Mineflayer world lookups need `Vec3` positions.** `bot.blockAt({ x, y, z })` crashes with "pos.floored is not a function". Every adapter converts with `toVec3` (`src/bot/vec3.ts`); `FakeBot.blockAt` throws the same error for plain positions so a missed conversion fails a unit test.
- **Mineflayer's `bot.craft` is unreliable on 1.21** (found by the e2e tests, not fixable by retries): it predicts clicks on the client, and since 1.17 the server silently ignores a click whose window state is stale, so crafts fail half way (ingredients left in the grid, a stack left on the cursor, "missing ingredient"). `WindowCrafter` (`src/bot/window-crafter.ts`) crafts by clicking instead: after every click it waits a few ticks, after every grid change it syncs the window with the server, it checks that the server offered the expected result, and takes it with a shift-click. It is installed as `bot.craft` by `installWindowCrafter` **after spawn** (Mineflayer injects its own craft plugin as the bot joins and would overwrite it earlier).
- Protected areas (`protect_area`, `unprotect_area`, `list_protected_areas`) are boxes saved per world by `ProtectedAreas`; `collect_block` consults them through `AreaGuard`.

### Hunting and food

- `HuntAnimalsSkill` (`hunt_animals`): goal is `item` + `count` (items gained, matched by name; `wool` means any colour; a cooked name such as `cooked_beef` hunts the raw meat and cooks it) or `species` + `count` (animals killed). It picks the nearest huntable animal, kills it through `AnimalKiller` (shared `Combatant`, 1-second slices, give up on an animal after 20 s of chasing), picks up the drops with `DropCollector`, and repeats. Stops are typed: `no_animals`, `protected`, `breeding_floor`, `inventory_full`, `time_limit`, `unreachable`, `aborted`; the message and `detail` say what was done, and the result reports the animal counts before and after. A resumed hunt only does what is left.
- **What is never hunted** (`animal-catalog.ts`, pure and table-driven): anything not in `HUNTABLE_SPECIES` (cow, mooshroom, pig, sheep, chicken, rabbit), animals with a name tag, tamed (owner set), saddled or ridden ones, babies, animals in pens (`PenDetector`: fences, fence gates, walls, or iron bars within 3 blocks on at least 3 sides), and the last two adults of a species in view (`BREEDING_FLOOR`; all adults in view count, protected ones included). Each can be overridden by a `hunt_animals` parameter; `attack_entity` needs `force` for a protected one.
- Animal facts come from entity metadata: `bot.registry.entitiesByName[name].metadataKeys` names each index (`baby`, `custom_name`, `owneruuid`, `saddle`). Leashed animals are not detected (Mineflayer does not expose the lead).
- **Low food.** `FoodPolicy` (`ask` default, `hunt_and_cook`, `stop`; tool `set_food_policy`, mirrored as the standing instruction `food_policy` so the briefing shows it) is applied by `LowFoodResponder` when `AutoEat` finds the bot hungry with nothing to eat (at most every 5 minutes): `ask` pushes a `needs_decision` event, `hunt_and_cook` starts `hunt_animals` for 3 animals with cooking (through the tool registry, 2 seconds later so the eating reflex has finished; no agent round trip), `stop` cancels the running task.
- The e2e scenarios need a difficulty above peaceful for the hunger test (on peaceful the food bar refills by itself).

### Storage

- `ContainerIndex` remembers containers per world (position, block, optional unique label, `protected`, `auto` when found by scanning, last-seen contents and free slots, when it was opened). Registering a known place, or the other half of a double chest, updates the entry instead of adding one. `StorageRules` map item names or groups to a container with a priority; `StoragePolicy` is the standing answer for a full inventory (`ask` default, `offload_and_return`, `stop`, plus `maxTrips` and `maxDistance`).
- **Item specs** (`src/skills/storage/item-matcher.ts`) are exact item names or groups (`*`, `logs`, `planks`, `wood`, `stone`, `ores`, `ingots`, `food`, `tools`, `armor`, `blocks`, `wool`, `dyes`); adding a group is a line in one table. **Reserved items** (tools, weapons, armor, food, torches, buckets) are never deposited unless named by exact name or `include_reserved`.
- `ContainerSelector` (swappable strategy): the first rule that matches (highest priority first) wins and is used wherever the container is; otherwise the nearest known container with room within `maxDistance`; otherwise a nearby container nobody registered (registered on use). Protected containers are never chosen, for depositing or withdrawing.
- `ContainerVisitor` walks to a container, checks the block is still one (a vanished container is removed from the index), opens it, records the contents before and after, and closes it. `DepositItemsSkill` groups items by target, visits nearest first, skips full or failed containers and retries the rest elsewhere, and reports what did not fit (`no_storage_space` when nothing fit). `WithdrawItemsSkill` reads what a container really holds (the index may be stale). `ScanContainersSkill` refreshes and registers; `FindItemsSkill` answers from memory and scans when memory has nothing.
- **Moving items is done by clicking, not with Mineflayer's `deposit`/`withdraw`** (same reason as crafting: they predict clicks and the 1.21 server ignores stale ones). `WindowTransfer` shift-clicks whole stacks, moves part of a stack with single right-clicks, and syncs with the server after every step; a shift-click that seems to have moved nothing is only believed after four looks, because a sync can be answered by an older update (found by the e2e test: a 100-item deposit stopped after one stack). The window comes from `bot.openContainerWindow`, installed after spawn by `installContainerWindows`.
- **Full inventory.** `InventoryFullHandler` is used by `collect_block` and `hunt_animals` (per-call `on_inventory_full`, else the standing policy): `stop` ends the task; `offload_and_return` deposits everything that may be deposited, walks back to where the bot stood, and continues (up to `maxTrips` per task, then it asks); `ask` pauses the task. When offloading fails (no container with room), it falls back to asking, with the reason in the question. `hunt_animals` with `cook` and `deposit_cooked` puts the cooked meat into a container by the storage rules.
- **Pausing a task** (`waiting_for_input`): a skill calls `context.ask({ message, options })`; the task keeps its slot, shows the question in `get_task_status` (`waitingFor`), and the app pushes a `needs_decision` event. `resume_task` answers with one of the options (`TaskManager.answer`); a cancel resolves the question with undefined. Tools return at once when a task starts waiting, so the agent does not sit out its wait budget.
- Registering by "the chest I am looking at" casts a ray from the owner's eyes (`bot.world.raycast`, missing from Mineflayer's typings, so `world` is excluded from the compile-time guard in the factory).

### Handing items over

- `give_items` (`GiveItemsSkill`): `RequestPlanner` + `ItemResolver` turn the player's words into concrete items and amounts (`count`, `stacks`, or `all`). The resolver knows exact item names, plurals, everyday words (`cobble`, `steak`), and the item groups of the storage feature; when several things fit ("iron", "wood") it prefers what the bot carries or has in chests, and if that still leaves more than one it fails with `ambiguous` and the candidates (with counts), so the agent asks. A group takes the item there is most of first. Requests **by group** leave out the reserve (tools, weapons, armor, food, torches, buckets) unless `keep_reserve` is false; an exactly named item is always given.
- Source order: the inventory, then containers (`WithdrawItemsSkill`, never protected ones); when the known containers do not have enough it looks into the others once (`ScanContainersSkill`) and retries. It gives what is available and reports the rest as `shortfall`; with nothing available at all it fails with `shortfall`.
- Delivery (`mode: drop`): find the player (`player_not_online`, `player_not_visible` when out of view, for example far away or in another dimension), walk to 1.5 blocks, check the spot (`DropSpot`: no lava, fire, or water, and solid ground), face the ground just ahead toward the player, throw each item (`ItemThrower`, 300 ms apart), step back 4 blocks so the bot does not pick its own items up, and wait up to 8 s to see whether they vanish; what still lies there is `unclaimed` and goes to drop recovery (see below), which takes it back after a minute unless told not to. `mode: chest` deposits into the named chest (or by the storage rules) and says which; `drop_items` throws at the bot's own feet (junk) and steps away.
- **Throwing is done by clicking** (`WindowDropper`: Ctrl+Q per whole stack, Q per single item for small parts, or pick up the stack and put the part to keep back), with syncs after every step, for the same reason as crafting and chests. The window is `bot.inventoryWindow`, installed after spawn.
- **Gotcha found by the e2e test:** a throw sent right after `bot.lookAt` flew in the *old* direction, past the player and out of their pickup reach, about half of the time. The server learns the new look with the bot's next movement packets, so `MineflayerGaze` waits four ticks after looking.

### Drop recovery

- **Death.** `DeathWatcher` (Mineflayer `death`, `messagestr`, `respawn` events) reports the death at the respawn. `DeathResponder` cancels the running task (cancel reason `died`), waits two seconds for the inventory to settle, and compares what was carried before with what is carried now: nothing lost means keepInventory is on (event and chat line, no record). Otherwise it writes a `DropRecords` entry (`kind: death`, place, dimension, time, cause, what was lost), emits a `bot_died` event, says the coordinates in chat, and, when `DropRecoveryPolicy.death` is `auto`, has `AutoRecovery` start the recovery three seconds later. With `skip` the record is `abandoned` and the coordinates are announced. A bot that dies **while a recovery is running** does not go back on its own (that is how a deadly spot would cause one death after another); it emits the event and the agent asks the player.
- **Records** (`src/state/drop-records.ts`, saved per world): status `pending`, `recovering`, `recovered`, `partial`, `abandoned`, `expired`, `gone`; items vanish 5 minutes after the drop, and `expireStale()` marks older records `expired` (called when listing, recovering, and building the briefing). The session briefing lists the ones that can still be fetched as `pendingDrops`; nothing is recovered automatically after a restart.
- **`RecoverDropsSkill`** (`recover_drops`), in this order: pick the record (the newest fetchable one by default); refuse with a typed failure when it is expired, in another dimension (`wrong_dimension`), tried `max_attempts` times already (default 2), or when the walk cannot finish before the items vanish (`checkDeadline`, pure: 3.5 blocks per second, a 10 s pickup allowance, a 20 s margin); walk to 6 blocks from the spot; `HazardAssessor` looks for lava, fire, cacti, magma, deep water, no ground below, and hostile mobs within 12 blocks (endermen ignored) and, when it finds any, pauses with `context.ask` (`try_carefully` or `abandon`; without a way to ask it abandons); sweep the items within 12 blocks of the spot with `DropCollector` (up to four rounds), skipping what `DropIgnoreList` says the bot threw away on purpose (same name within 6 blocks, less than 5 minutes ago; `drop_items` feeds it); `equipBestGear` (armor, best weapon, shield); report what was recovered and what is still missing against the pre-death snapshot. The record is never left `recovering`: on any exit it becomes `pending` or `partial`, keeping what was picked up.
- **Unclaimed handover drops.** When `give_items` (drop mode) ends with items nobody picked up, `UnclaimedDropHandler` writes an `unclaimed` record (`at` is the moment of the throw) and, unless the call said `recollect_unclaimed: false` or the standing policy for `unclaimed` is `skip`, has `AutoRecovery` fetch them `UNCLAIMED_DROP_WAIT_SECONDS` (default 60) after the throw. Only the thrown item names within 12 blocks of the spot are taken. Nothing left there means `gone` (somebody took them).
- **Tools.** `set_drop_recovery_policy` (`auto` or `skip`, per situation `death`, `unclaimed`, or both; mirrored as the standing instruction `drop_recovery_policy`), `skip_drop_recovery` (cancels a running or waiting recovery and marks the records `abandoned`, returning the coordinates), `recover_drops`, `list_death_records` (both kinds).
- **Gotcha found while building it.** The `AvoidLava` reflex also fires for lava next to the bot, so a spot with lava right beside the items makes the reflex pull the task back and forth; the attempt limit is what ends it. Death drops, the snapshot, and the keepInventory check depend on `bot.inventory.slots` (all slots, including armor and the off hand), not `bot.inventory.items()`.

### Server commands and teleporting

- `ServerCommands` (`MineflayerServerCommands`) types a command as chat (`/tp ...`) and waits up to 1.5 s for the server's answer (`messagestr` lines that are not another player's `<name> text`). `available(command)` reads the command list the server sent at login (`declare_commands`, parsed by `commandNamesFrom`, stored by the factory as `bot.commandNames`): the server only lists what this player may use, so a missing `tp` means "not an operator, or cheats are off". The list is resent when `/op` or `/deop` happens, so `get_status` (`commands.canTeleport`: true, false, or null before the list arrives) follows it live.
- `TeleportSkill` (`teleport_to_player`, `teleport_to_position`): `no_permission` (with the exact instructions: open the world to LAN with "Allow cheats: ON", then the host types `/op <bot name>`; the bot cannot grant this itself) without sending anything when `tp` is not offered; `player_not_online`; `unknown_command`; `teleport_failed` with the server's words. It then checks that the bot really moved (a server may answer nothing). A player target puts the bot on the player's own block, so it steps to a safe spot beside them (no lava or water, solid ground, headroom).
- **Only on the player's request.** The tool descriptions say so, and no reflex, task, or responder ever calls them. Teleporting can also cross dimensions, and it skips everything between: use it because the player asked, not because walking is slow.
- Reply classification is by wording (`classifyReply`), because the text arrives without colours. Anything unrecognised counts as success and the skill verifies the effect, so a misjudged reply costs a clearer message, never a wrong action.

### Construction and building

- **Plans.** Everything that changes blocks in bulk is a `WorkPlan` (`src/skills/construction/`): `place` a block (an item name) in a cell, `break` a cell, or `light` a cell (a torch, only when the cell is darker than `minLight` and no torch is within 4 blocks). A shape is a provider (`BlueprintProvider` for building; excavation and railways add their own). `PlanExecutor` carries a plan out and is shared by all of them.
- **How the executor works.** Before it starts it refuses, changing nothing, with typed reasons: `protected_area`, `unsafe_site` (lava in or next to the volume), `blocked_cells` (other blocks in the way; `clear_obstacles` breaks natural ones instead), `missing_materials` (with `needs` and `missing`; torches are never counted as missing). Then it repeats: take the first step that can be done now (a placement needs a solid neighbour to be placed against, preferring the block below, so a wall grows from the ground up whatever order the provider lists), choose a standing spot within reach that is not in a cell still to be built and not inside the volume when there is a choice (`StandingSpotChooser`), walk there, place or break (dropped items are picked up), and confirm the block appeared. A step is tried three times, five failed steps in a row end the plan as `stuck`, and unfinished work ends as `incomplete`. A second look at the end verifies everything (`verification_failed` if something did not hold). **Steps already done are skipped, so re-running the same plan is how an interrupted one continues** (no separate cursor).
- **Blueprints** (`src/skills/building/`): `floor`, `walls`, `box` (floor, walls, roof, a 1×2 doorway at z = the origin by default, `lit` for torches), `solid`, `block`. The origin is the blueprint's lowest corner (smallest x, y, z); without one, it is two blocks east of the bot on its level, and `preview_build` says so (`defaultOrigin`). Each provider validates its own parameters with a zod schema, which `list_blueprints` turns into JSON schema for the agent. A new shape is a new provider registered in the composition root.
- **`BuildSkill`** turns the blueprint into a plan, fetches missing materials from containers (`fetch_from_storage`, default true; `StorageMaterialFetcher` asks the known containers first, then looks into unopened ones), and runs the executor. `preview_build` reports what it would take: blocks to place and break, what is already built, needs, missing, blocked cells, protected areas, hazards.
- **`Placer.placeAgainst(item, reference, face)`** places against any face (walls, ceilings, torches on walls); `placeAt` remains for workstations. The `LightReader` port reads block light (not sunlight).
- **Houses, shelters, custom shapes.** `house` builds a floor, walls (3 to 8 high), a flat roof, a 1×2 doorway in the north wall (z = the origin) with a real door placed last, optional windows and torches. `shelter` builds a sealed 1×2 room (walls two high, roof, no floor) **around the bot** from the inside: no origin is needed (the default origin puts the blueprint's anchor cell where the bot stands), and to leave, the bot breaks a wall block. `custom` takes `layers` (bottom to top; rows north to south; characters west to east) and a `legend` from characters to item names (`.` and space are empty), up to 32 per side and 4000 blocks; `*_door` items are placed last and turned to fit their wall.
- **Doors and facing.** A door's orientation follows where the bot looks when it places it, so a place step can carry `alignAxis`: the bot then stands in line with the cell along that axis, one to three blocks away (`StandingSpotChooser`), and the door lies in the plane of the wall.
- **Pillaring up** (`Scaffolder`, used by the executor when `max_scaffold_height` is above 0, default 12). A step with no standing spot within reach (about 4.8 blocks above the ground) is set aside; when the ground work is done, the executor takes the lowest of them, plans a tower beside it (`plan`: a ground cell within 3 blocks with a free column above, none of it in a cell still to be built, in a protected area, or next to lava, outside the building when possible; the smallest height that brings the cell within reach), walks to its foot, and raises it: jump, place the scaffold block against the block below, wait until it stands on it, repeat. From the top it does everything within reach (raising the tower another block while higher steps remain), then **takes the tower down from the top by breaking the block underfoot** (never a fall of more than one block) and picks the blocks up. It always descends, also when cancelled or failed (the descent ignores the cancelling signal). `preview_build` reports `scaffold` (steps too high, estimated height) and counts the scaffold blocks in `needs`. The scaffold block must be breakable with what the bot carries: dirt is the default because cobblestone by hand drops nothing. A tower left standing after a crash or a disconnect is not removed automatically.
- **Not built yet:** tool durability swapping and crafting a replacement (a needed tool that is missing stops the plan with `no_suitable_tool`; excavation adds wear handling), stairs and pitched roofs, beds inside houses (with the sleeping feature), and a persisted record of towers, so a crash could clean up.

### Excavation

- **Shapes** (`src/skills/excavation/`, each an `ExcavationProvider` that validates its own zod numbers): `pit` (width × length × depth), `shaft` (1×1 by default, also checked for caves), `quarry` (width × length down to `to_y` or `above_bedrock`, default **9 above the bedrock**: y = −55 in the overworld, the lowest layer being −64 there and 0 in the Nether and the End), `tunnel` (direction, length, width 1, height 2, **no branches**), `branch_mine` (a main tunnel plus branches on both sides every `spacing`, default 3, each `branch_length` long: only when the request asks for branches), `staircase_down`. **Sizes are separate numbers**: the agent extracts them from the player's words (asking when unclear), and `preview_excavation` echoes them (`interpreted`), so a wrong reading shows before anything is dug. Pits, shafts and quarries start at the ground block two blocks east of the bot (their origin is the lowest corner of the top layer); tunnels, branch mines and stairs start at the bot's own cell.
- **The hazard rule** (`HazardRule`, used by any plan with `hazards: 'end_branch'`): before a block is broken, it and the six blocks that touch it are looked at. **Lava or water in any of them: the block is not broken and that chain ends one block short** (`hit_lava`, `hit_water`). Also ending a chain: an open cavity ahead or around the opening that the dig did not make itself (`cave_breakthrough`, only for shapes that check, using the step's `probe` list, which leaves out the way the bot came from), sand or gravel overhead (`falling_blocks`), a spawner (`spawner`), chests, rails, furnaces, and other made things (`player_block`), and a block that is not loaded (`unloaded`). The bot never breaks those. Every chain that ended early is reported in `ended` with the reason, the place, and how many cells were left; other chains carry on. A cell counts as dug by the dig itself when it comes earlier in the plan or was broken in this run (so mined ore and earlier sections are not mistaken for caves).
- **Chains and dependencies.** A break step has an optional `branch` (the chain a hazard ends), `needs` (a cell that must be open first: each tunnel cell needs the one before it, so nothing is ever dug through rock from a distance, and a branch waits for its junction), and `optional` (ore veins: failing to reach one is not a failure). Steps that wait for a cell that was never dug are reported as `blocked_by_earlier`.
- **Light.** `light` steps carry `spacing` (no torch closer than that: tunnels every 6, branches and stairs likewise) and `required`: with no torches left the dig stops with `no_torches`, and the preview counts the torches (the agent crafts or fetches them; `fetch_from_storage` also tries the containers). A torch only goes into a cell that is already open.
- **Ore veins.** When the plan asks (`veins`), any ore (`*_ore`, ancient debris) touching a dug cell is mined with its vein (26-neighbourhood flood fill, up to 64 blocks), under the same hazard rule, never inside a protected area. The bot does not use knowledge of buried blocks to steer: it digs the pattern.
- **Ladders.** Pits, shafts and quarries place a ladder in the west-wall column after each layer (`place` step with `against`), so the bot can climb out; `exit: none` leaves it out. The ladder count is in the preview's `needs`. A resumed dig does not dig its own ladders out again.
- **Storage.** Spoil is handled by the standing storage policy like every other task (`on_inventory_full`), and dropped items are picked up as the dig goes.
- **Exits, water landing, spoil, supplies** (`feature/excavation-extras`). `exit: 'stairs'` (pits, shafts, quarries) cuts a helical staircase around the outside of the footprint instead of ladders (`ringAround`, `stairStep`: one step per layer, one cell wide, three cells high by default, every step needs the previous one; **not built yet:** `stair_width`/`stair_height` to change that, default height becoming 4 — see below). `water_landing: true` (quarry only) digs a 2x2x2 pond pit in the far south-east corner below the floor and places two `water_bucket` items diagonally (a bucket is *used* with `activateItem` after looking at the face, never `placeBlock`); the buckets come from the inventory or storage. `spoil_policy: 'discard_junk'` throws surplus cobblestone, dirt, gravel and the like away (`SpoilDiscarder`, junk beyond a stock of 64) when the inventory is full, and `DropIgnoreList` keeps the bot from picking them up again. `no_torches` is answered by crafting torches (batches of 8, `CraftingSupplies`) and a missing pickaxe by crafting the cheapest spare (wooden, stone, iron, diamond); only when materials are missing does the dig stop. `seal_hazards` was not built: the hazard rule never opens a face towards fluid, so there is nothing to seal.
- **Cave sealing** (`feature/excavation-cave-sealing`, found in a live test): a cave crossing a quarry's footprint or its exit-stair ring used to leave open walls, floor, and steps, because `pit` and `quarry` dug with `cavityCheck: false` (only `shaft` checked). `pit`, `quarry`, and every other shape now set `cavityCheck: true`, so a column stops one cell short of a cave the same way everywhere. On top of that, a new **seal pass**: a `cave_breakthrough` hazard, with `seal_caves` on (the default), **places** a block (`seal_block`, default cobblestone, falling back to dirt, never counted as missing up front — like torches, it is a best-effort courtesy) at the open cell instead of ending the chain there, then the SAME cell is re-dug if it was also one of the plan's own cells (a coincidence the pending/round bookkeeping would otherwise miss for a whole round), so the chain reaches its planned extent. `exit: stairs` and `exit: ladder` also get a `seal` step for the tread and the wall the ladder hangs on, backfilling either if a cave had hollowed it out first; with nothing carried to seal with, the cell is simply left open rather than failing the whole plan. `seal_caves: false` turns all of this off for a player who wants to break into a cave on purpose.
- **Stair sizing** (`feature/excavation-stair-sizing`, found in a live test): the helical staircase used to be fixed at 1 cell wide and 3 tall. `stair_width` and `stair_height` on `exit: stairs` (pit, shaft, quarry) change that; default width stays 1, **default height is now 4**. `stair_width` widens `ringAround`'s band radially outward from the footprint (each `RingCell` carries the unit step `dx`/`dz` back towards it; `stairStep` widens inward from the outer ring by that many cells) — a thicker walkable corridor, not a longer one; `stair_height` changes `stairStep`'s cell count. A widened cell `needs` the single-wide spine cell at the same height, not the cell before it around the ring. Never counted into the quarry's own `width`/`length`; `preview_excavation`'s `interpreted` echoes the numbers given and `bounds` naturally covers the wider stairs too.

### Tasks

- The `TaskManager` (also the default `StopHandler`) runs **one** active task at a time; a task waiting for input still holds the slot. Starting a new one requires cancelling or queueing the current one explicitly.
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
| Movement | `goto`, `follow_player`, `stop`, `lead_player` (not built yet) |
| Autonomy | `set_autonomy`, `get_autonomy_status`, `get_will`, `set_will`, `add_goal`, `update_goal`, `remove_goal`, `list_goal_kinds`, `get_autonomy_log` (off by default; not built yet) |
| Doors | ordinary doors, gates, and trapdoors are opened by walking tools themselves (not built yet); `press_switch`, `open_door`, `find_switches` for iron doors and buttons, levers, and plates (not built yet) |
| Gathering | `collect_block`, `pickup_items` |
| Crafting | `craft`, `smelt`, `list_recipes` |
| Protection | `protect_area`, `unprotect_area`, `list_protected_areas` |
| Hunting | `hunt_animals`, `list_huntable_animals`, `attack_entity`, `set_food_policy` |
| Handover | `give_items`, `drop_items`, `resolve_item` |
| Drop recovery | `set_drop_recovery_policy`, `skip_drop_recovery`, `recover_drops`, `list_death_records` |
| Storage | `register_container`, `label_container`, `list_containers`, `scan_containers`, `set_storage_rule`, `list_storage_rules`, `remove_storage_rule`, `deposit_items`, `withdraw_items`, `find_items`, `set_storage_policy` |
| Building | `build`, `list_blueprints`, `place_block`, `preview_build` (blueprints: floor, walls, box, solid, block, house, shelter, custom) |
| Excavation | `excavate` (pit, shaft, quarry, tunnel, branch mine, staircase_down, room: not built yet; `stair_width`/`stair_height`, `seal_caves`/`seal_block`), `preview_excavation`, `list_excavations` |
| Signs | `place_sign`, `edit_sign`, `remove_sign`, `read_signs` (not built yet) |
| Site leveling | `flatten_area`, `preview_flatten` (cut, fill, and clear a rectangle to a level; not built yet) |
| Railways | `plan_railway`, `build_railway`, `place_minecart` |
| Sleeping | `sleep`, `set_respawn_point`, `place_bed`, `list_beds`, `set_sleep_policy` (never in the Nether or the End: a bed explodes there) |
| Farming | `build_farm` (field, pen), `plant_crops`, `harvest_crops`, `breed_animals`, `collect_eggs`, `set_egg_policy`, `tend_farm`, `inspect_farm`, `discover_farm`, `plant_trees`, `harvest_trees`, `list_farms`, `register_farm` |
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
  - **Known intermittent failure (unexplained):** in `test/e2e/excavation/extras.e2e.test.ts`, the stairs test once failed 3 times in about 9 full runs on the assertion that the block under stair step 1 is dirt, then passed 6 runs in a row and 3 runs alone. The runs took the same time either way, so a sleeping machine or a stalled Docker container is unlikely; the cause is not known (a late RCON view, load, or a rare real dig bug). The check now reports which block it found, so a new failure shows the cause. If it comes back, look at that message first rather than just rerunning.
  - The Jest global setup/teardown are plain `.mjs` files because Jest loads them through Node's own loader, which cannot resolve `.js` imports to `.ts`. Jest also ignores `testTimeout` inside a project, so the timeout is set in `test/e2e/support/jest-setup.ts`.
- **E2E run policy:** e2e tests are grouped per feature. While developing a phase, run **only that feature's own e2e folder**, not the accumulated earlier ones. The complete e2e suite (`test:e2e:all`) is run once after all primary phases (final gate) and before any release merge into `main`. Unit and integration tests are cheap and always run in full.
- **Manual in-game check:** a human step at the end of each phase using the checklist in DEVELOPMENT-PLAN.md, with the real game client and your LAN world. It complements the automated tiers.
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
- Do not merge into `main` or force-push without an explicit request from the user.

## Runtime protocol (for the agent playing through this server)

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
- User-facing behavior (new or changed tool or reflex) has a smoke-level e2e scenario, and that feature's own e2e folder passes before merging into `development` (from the e2e-harness feature on). Do not run the full e2e suite per phase; it is reserved for the final gate and releases.
- The work is on a `feature/*` branch created from `development`.
- New tool: has zod schema, LLM-oriented description, registered in the composition root, listed in the tool table above.
- No Mineflayer imports outside `src/bot/`; no stdout writes.
- README/plan updated if behavior or configuration changed.