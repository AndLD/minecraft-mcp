# Backlog

Ideas, deferred work, and known gaps that are not in [DEVELOPMENT-PLAN.md](DEVELOPMENT-PLAN/DEVELOPMENT-PLAN.md) yet. Nothing here is committed to: an item moves into the plan (with its own `feature/<name>` branch) when it is picked.

Each entry says what it is, why it might be worth doing, and what is known about the approach.

## Features

### Voice instructions

Give instructions to the bot by speaking instead of typing in game chat. The bot's side needs no change: the agent already receives instructions as text, so the work is turning speech into text. Two options were discussed, to choose between later (they can also be combined).

**Option A: voice to the agent (no code)**
- The player uses dictation or a voice mode in the Claude client, and the agent calls the bot's tools as usual.
- Pros: nothing to build.
- Cons: only works while the player is at the keyboard with the client focused; not usable while playing full screen.

**Option B: push-to-talk companion**
- A small local program records while a key is held, transcribes the audio with a speech model (local or API), and pushes the text into the same `AgentInbox` that in-game chat feeds, as a chat message from the owner (or a `voice` event).
- Pros: works while playing; fits the existing design; a spoken "stop" can be matched in code by a `ChatCommand`, so it never waits for an agent round trip.
- Cons: a new component to build and run; recognition errors.
- Design notes: hide the recognizer behind a `SpeechToText` port (Dependency Inversion), a `VoiceInput` adapter for the microphone and key, and one new class that feeds `ChatRouter`. Read risky or destructive instructions back in chat and wait for a yes before acting. Never treat voice as a different trust level than chat: the same owner rules apply.

**Rejected:** capturing in-game voice chat (for example the Simple Voice Chat mod). It needs a mod on the server and on the player's side, and vanilla via TLauncher has no voice channel.

### Several bots managed by one agent (horizontal scaling)

One agent running N bots in the same world. Left for later on purpose; the analysis so far:

- **Mineflayer is not the obstacle.** Several bots in one process work, and every `Mineflayer*` adapter only talks to a `BotHolder`, so skills are already independent of which bot is behind them.
- **What is single-bot by construction:** `createApp()` builds exactly one connection, `TaskManager`, `ReflexEngine`, inbox, death responder, and set of policies. The fix is a `BotRuntime` (the per-bot wiring) built N times, with `createApp()` becoming a factory plus shared services.
- **Tools** have no `bot` argument. One optional `bot` parameter, routed once in `ToolRegistry` (defaulting to the only bot), covers all tools.
- **Inbox and chat:** events need a bot name; `ChatRouter` needs addressing ("Bot2, get wood") or every bot obeys every message; `stop` needs a scope.
- **World state:** `WorldStateManager` closes the profile when one bot disconnects, so it needs reference counting. Death records, the task journal, and the food policy become per bot; containers, protected areas, storage rules, and landmarks stay per world.
- **The real design work is concurrency between bots:** two bots taking from the same chest, mining the same tree, or picking up each other's drops. That needs leases or reservations on containers and work areas.
- **Effort:** minimal (N independent bots addressed by name, shared chest memory) about one session; robust (leases, chat addressing, cross-bot handover, splitting one job among bots) two or three more.
- **No-code alternative today:** N MCP server processes, each with its own `MC_USERNAME` and its own `DATA_DIR` (two processes must not write the same profile files). No shared chest memory.
- **Best moment:** before the construction engine, whose `PlanExecutor` is where several bots pay off most (a plan can be partitioned among them). Adding it after the later phases means touching many more files.

### Autonomy: the bot's own will

_Moved here from the development plan (it was Phase 28): not planned for now. Rough estimate: 2.5 sessions._

**Would build on:** [Persistent state](DEVELOPMENT-PLAN/phases/persistent-state.md), [Survival reflexes](DEVELOPMENT-PLAN/phases/survival-reflexes.md), [Gathering, crafting, smelting](DEVELOPMENT-PLAN/phases/gathering-crafting-smelting.md), [Hunting and food](DEVELOPMENT-PLAN/phases/hunting-food.md), [Storage and containers](DEVELOPMENT-PLAN/phases/storage-containers.md), [Construction engine and building](DEVELOPMENT-PLAN/phases/construction-building.md), [Excavation and mining](DEVELOPMENT-PLAN/phases/excavation-mining.md), [Farming, crops, animals, and trees](DEVELOPMENT-PLAN/phases/farming.md), and optionally [Railways](DEVELOPMENT-PLAN/phases/railways.md), [Sleeping and respawn point](DEVELOPMENT-PLAN/phases/sleeping-respawn.md), and [World discovery](DEVELOPMENT-PLAN/phases/world-discovery.md). When it is picked, it becomes a phase again (with the number after the last finished one) and its own `feature/autonomy-*` branches.

- **Two branches:** `feature/autonomy-engine` (the will, the engine, the switch, the needs, the limits, the log, the tools; about 1.5 sessions) and `feature/autonomy-goals` (the goal kinds that turn wishes into tasks; about 1). Every earlier skill is a tool the engine can use, which is why this comes late.
- **Who decides what.** Priorities from top to bottom: **reflexes** (staying alive, unchanged), **the player's instructions** (anything the owner says or asks always wins), **needs** (food, tools, a full inventory, light, night), **the will's goals**, **idle** (nothing to do: rest, report, ask the agent for more). Autonomy never overrides a reflex and never runs while a player's instruction is being carried out.
- **The will** (`WillStore`, persisted per world, `ProfileScoped` like the other state, versioned JSON): written by the agent through tools, in numbers and names the engine can use:
  - `identity`: a short character and style for the bot's chat lines (how it talks, how often it reports);
  - `home`: the landmark the bot lives around and works from;
  - `goals`: each has an `id`, a `kind` (from the catalog below), `params`, a `priority`, and an optional stop condition (`until`: a stock level such as 64 logs in the chest, a count, a size, a date, or never) and repeat (`every`);
  - `boundaries`: what the bot must never do while acting on its own (see the limits below), on top of protected areas, standing instructions, and every policy that already exists.
- **Goal kinds** (each a `GoalStrategy`, a new one is a new class, registered in the composition root; a strategy turns a goal and the current state into **one concrete task** through the tool registry, so everything it does is an ordinary, cancellable, journalled task): `stock` (keep an item at a level in a chest: gather, hunt, smelt, or craft what is needed), `farm` (`tend_farm` on a group, replant, breed, collect eggs), `build` (a blueprint at a plot, with materials fetched or gathered), `improve_home` (a list of blueprints and rooms the agent wrote, done in order), `excavate` (a dig from the will), `explore` (find a kind of structure), `tidy` (deposit by the storage rules), and `rest` (sleep at night, stand in shelter). A goal that cannot be done because of a typed failure gets the usual answer: `missing_materials` adds a gather step, `no_suitable_tool` a craft step, `inventory_full` follows the storage policy, and anything else marks the goal `blocked` with the reason so the agent can change the will.
- **The engine** (`AutonomyEngine`, a small state machine using `Clock`, `Random` for seeded tie-breaks, and `Scheduler`; no Mineflayer): `off`, `watching` (nothing to do yet), `acting` (one task running), `waiting_for_approval` (only with `require_approval`), `paused_by_player` (the owner spoke or said `stop`), `paused_by_reflex`, and `blocked` (every goal is blocked or done). It picks the goal with the highest priority that is due and not blocked, launches it, records the result, and repeats. **When the will runs dry or every goal is blocked, the engine tells the agent** (an `autonomy_needs_will` event in `wait_for_chat`) and idles or rests until the agent extends the will. **Without an attached agent the bot only repeats and maintains what the will says** (stock levels, farms, upkeep); inventing new projects needs the agent.
- **The switch, and approval as a second, separate switch.** `set_autonomy` takes two independent settings:
  - **`enabled`**: **off by default, and off after every restart**. Turned on by the agent, or by fixed commands in code that never wait for the agent (`ChatCommand`s, like `stop`): **`autonomy on`** and **`autonomy off`** from the owner's chat. The owner's `stop` cancels the running task and **pauses** autonomy (not off) until they say to go on.
  - **`require_approval`**: **off by default**. With it off, the bot **does not wait for the owner's approval**: it acts on its will as soon as it is enabled, and a will (or a new goal) that the agent writes takes effect at once, visible in `get_will`, the session briefing, and the log, and changeable or removable by the owner at any time through the agent. With it on, the bot says in chat what it wants to do next and waits for a yes (`needs_decision`, answered with `resume_task`), and new or changed goals from the agent wait for the owner's yes before they count. It can be limited to some goal kinds (`approval_for`, for example `excavate` and `build`) and is switched by the owner's chat (`autonomy approval on` and `off`) as well as by the agent.
- **The player always comes first.** When the owner speaks, the engine finishes or cleanly aborts the current step at the next safe point and hands over to the agent; it goes back to its own will by itself after a quiet time: **default 4 minutes** without a message from the owner (`resume_after_minutes`, 1 to 30, in `set_autonomy` and the will's `boundaries`; 3 to 5 is the intended range), or at once when told "carry on", and never while a player's task is still running. The bot chats like a player, not like a log: one short line when it starts something bigger, when it finishes, or when it is stuck, at most one per minute, in the voice of `identity`.
- **Limits** (`Governor`, checked before every task and while it runs; the defaults can be changed in `boundaries` and by the player): stay within a radius of home (default 200 blocks); do not change dimension or teleport; never break or build in protected areas or inside player-built structures (all existing rules); no work at night away from shelter unless the goal needs it; a maximum length per task and a maximum number of tasks per hour; do not spend the last food and torches; do not take from or empty protected containers; **a kill switch: after 2 deaths in an hour, or 5 blocked goals in a row, autonomy turns itself off and tells the owner** (a bot that keeps dying should not keep going). Anything that needs a decision the will does not cover (dig deeper than allowed, a danger it does not know) becomes a `needs_decision` event, never a guess.
- **Visible and reviewable.** `AutonomyLog` (bounded, persisted) records every decision with the reason ("stock: logs 12 of 64, gathering 30"), the task it started, and the result; the session briefing shows whether autonomy is on and whether approval is required, the current goal, the last decisions, and blocked goals. `get_autonomy_log` lets the agent review and revise the will, and nothing happens silently.
- **Tools:** `set_autonomy` (`enabled`, `require_approval`, `approval_for`, `resume_after_minutes`), `get_autonomy_status`, `get_will`, `set_will`, `add_goal`, `update_goal`, `remove_goal`, `list_goal_kinds` (each kind with its parameter schema, so the agent writes valid goals), `get_autonomy_log`. All validated with zod at the boundary; a will with an unknown kind or bad parameters is refused with the reasons.
- **Safety and the operator.** Autonomy is a switch the operator owns: it is **off after every start**, and an unattended bot acting in the operator's real world is exactly what the live-testing rule guards against, so turning it on in a real LAN world is announced in chat and needs the owner's own command or a clear yes; the agent asks before switching it on. Approval per action is a different thing and is off by default (see the switch). Every action is an existing tool with its own safety checks, so autonomy adds decisions, not new ways to change the world.
- **Tests:**
  - unit: the state machine over a fake clock, fake random, and a fake task launcher (each transition, priority order of reflex, player, needs, goals, idle; a chat message pauses and the quiet time (4 minutes by default, changeable) resumes it, and a new message restarts the count; `stop` pauses; abort; with `require_approval` off nothing waits, with it on the engine waits for the answer and a `no` skips the goal, and `approval_for` limits it to some kinds), the `Governor` (radius, dimension, protected areas, night, hourly cap, food reserve, the kill switch on deaths and blocked goals), `WillStore` (validation, persistence, versioning, a corrupt file falling back), each `GoalStrategy` (goal and state give the expected task; typed failures give the expected follow-up; stop conditions and repeats), the log bounds, and the chat throttle
  - integration: the real engine, registry, and tools through the MCP layer on a stateful fake world: a will with `stock` and `farm` goals runs to its stop conditions, a player instruction preempts and the engine resumes, `set_autonomy off` cancels cleanly, a blocked will raises `autonomy_needs_will`, approval on and off (a will change from the agent is held until approved only when it is on), and a restart comes back with autonomy off
  - e2e: in the Docker server, a will "keep 20 oak logs in the chest" with autonomy on: the bot gathers, deposits, and stops at 20 (checked through RCON); the owner bot's chat message pauses it and `autonomy off` stops it; a boundary radius is respected; two deaths switch it off
- **Exit criteria:** with a will written by the agent ("keep the chest stocked with logs and food, tend the farm every day, and build these rooms next to the house"), turning autonomy on makes the bot work through it on its own, without waiting for approval unless `require_approval` is switched on, talking a little like a player, pausing whenever the owner speaks, stopping at once on `stop` or `autonomy off`, and telling the agent when it runs out of things to do; the log shows why it did each thing.

### Farming extras

Left out of the farming feature in the plan: shearing sheep, milking cows, honey (collecting eggs is now part of `feature/animal-farming`); sugar cane, bamboo, melons, cocoa, nether wart; composters; redstone auto-farms (observers, pistons, hoppers).

### Several connected rooms in one request

The planned `room` shape in Phase 15 digs one room per call. To connect rooms today, the player stands inside a dug room, looks at another of its walls, and asks for the next room behind it; the new entrance opens into the first room. What is missing is asking for a whole layout at once ("three rooms in a row", "a main room with two side rooms").

- **Idea:** a `rooms` layout in the excavation family: a list of rooms, each with its own size, placed relative to the previous one (its front, left, right, or back wall, with `entrance_at` and `door` for each link), optionally joined by a short corridor.
- **Approach:** one plan for the whole layout, so it resumes as one job, is checked for overlaps before anything is dug, and the preview lists every room and doorway. The same hazard rules apply to each room; a room that meets water or a cave ends only its own chain. One summary covers all rooms.
- **Effort:** about half a session on top of the single room, in `feature/dug-rooms` after the `room` shape.

### Take an item the player hands over ("take this pickaxe")

Today the player throws an item on the ground and asks the agent to pick it up: `pickup_items` with the item name walks onto it, and the digger and the combat code then use the best tool, weapon, or armour the bot carries, so a diamond pickaxe replaces a wooden one without any crafting chain. What is missing is one spoken step: "take this pickaxe" while the player holds it out or throws it.

- **Idea:** a `receive_item` tool: the bot goes to the player, says what it expects (or names the item the agent passed), and watches for a matching item that the player drops or throws near it, then picks it up and confirms in chat what it got. It waits a short time (about 30 s) and reports `nothing_received` when nothing comes.
- **Approach:** built from what exists: `give_items`' reverse. The player lookup and walking to 1.5 blocks, `DroppedItemScanner` filtered by the wanted name and the player's position at the throw, `DropCollector` to pick it up, and the `DropIgnoreList` left out of the check so items from the player are never mistaken for junk the bot threw away itself. Only items that appear near the player after the request count, so old drops on the ground are not taken.
- **Extra:** an optional "and use it" step, which equips the received tool or armour at once (`equipBestGear`) and says so in chat.
- **Effort:** small, well under a session; needs a Docker e2e scenario where the owner bot throws an item and the bot ends up carrying it.

## Deferred from finished work

### Survival reflexes
- **Fall-damage guard**: land in water with a bucket, or avoid the fall. Now part of the cave exploration feature in the plan (caves have drops). The pathfinder's default maximum drop already avoids large falls.
- **Night shelter**: build or dig in when night falls far from a bed. Same dependency. Having a bed to go to is the sleeping feature in the plan.
- **E2E scenario for a reflex pausing and resuming a real task**: covered by integration tests only.

### Hunting
- **Leashed animals** are not detected as protected (Mineflayer does not expose leads); the pen heuristic covers most cases.
- **Pen heuristic** only knows fences, gates, walls, and iron bars; a pen made of other blocks (stone walls, glass) is not recognized.
- **Cooking in smokers and campfires**: `smelt` uses a regular furnace only.
- **Fish and other food**: only livestock is huntable; fishing and foraging are not covered (farming is in the plan).
- **Deposit cooked food in chests** once the storage feature exists.

### Gathering, crafting, smelting
- **Blast furnace and smoker**: `smelt` only uses a regular furnace (twice as slow for ores and food).
- **Reaching high logs**: tall tree trunks cannot be finished from the ground because the bot never pillars up. Options: allow towering with a safe block, or leave the top logs. The pillar-up tower planned for building (`Scaffolder`) is the mechanism to reuse.
- **Bare-floor mining**: asking for `stone` on a stone floor digs the floor blocks next to the bot (never the one underfoot). A "surface only" or "walls only" option could keep the ground intact.
- **`InventoryWriter` port**: planned with the handover feature (equip, toss).

### Storage
- **`OrganizeStorage`**: sort everything already in the chests according to the rules.
- **Craft and place a new chest** when there is no storage space and the player allows it (`no_storage_space` currently falls back to asking).
- **Ender chests and shulker boxes carried in the inventory** are not handled (placed shulker boxes work like chests).
- **Free-space knowledge is remembered**, not measured: a container the player emptied since the last scan is still treated as full by the fallback selection until it is scanned again.
- **Building integration**: `build` fetching missing materials from the container index (comes with the building feature).

### Railways
- **Junctions**: joining a new line to an existing one, a branch off a main line, and crossings. Today an existing rail blocks a route (`existing_rail`), so lines never touch. Needs a way to reuse the existing rails as part of the route and to set the switch or junction layout (powered rails and the way a cart is steered).
- **Detector and activator rails**: for stations (a cart stops at a powered rail with no power, and a detector rail can trigger something when a cart arrives). Not part of a plain line; belongs with stations and junctions.

## Known issues from live sessions

Bugs and gaps found while playing, each written up with the cause and fix ideas under "Known issues" in the feature's own document. Each one moves into the plan (with a `fix/<name>` or `feature/<name>` branch) when it is picked. Every issue below is now planned in a `fix/` phase of the development plan (its link ends the entry); the write-ups stay in the feature documents and are removed there when the fix lands. Also picked from live sessions: breaking a block at exact coordinates ([Phase 23](DEVELOPMENT-PLAN/phases/break-block.md)), the crop field gate side and pumpkin fields ([Phase 25](DEVELOPMENT-PLAN/phases/crop-field-options.md)), filling buckets ([Phase 22](DEVELOPMENT-PLAN/phases/buckets.md)), and excavating upward and continuing an existing dig ([Phase 28](DEVELOPMENT-PLAN/phases/excavation-upward.md)).

- **`lure_animals` reports `penFull` when nothing could be led** and loses chickens that the bot outruns: [Animal farming, known issues](features/farming/animal-farming.md). Planned in [Phase 24](DEVELOPMENT-PLAN/phases/farming-fixes.md).
- **Extra grass inside a freshly built pen** leaves cells that are not free, and the pen's own protected area stops the bot from clearing them: [Animal farming, known issues](features/farming/animal-farming.md). Planned in [Phase 24](DEVELOPMENT-PLAN/phases/farming-fixes.md).
- **A crop field's water is at the field's edge and too little:** one source in the first row leaves far rows dry (a 7x7 field hydrated 5 of 7 rows), and a trench of water (or one block per 9x9 part, at its centre, on request) is the way it should work: [Crop farming, known issues](features/farming/crop-farming.md). Planned in [Phase 24](DEVELOPMENT-PLAN/phases/farming-fixes.md).
- **The crop field gate is placed a quarter turn wrong** (perpendicular to the fence), and so is a pen's: [Crop farming, known issues](features/farming/crop-farming.md). Planned in [Phase 24](DEVELOPMENT-PLAN/phases/farming-fixes.md).
- **The bot leaves gates and doors open behind it** (chickens walked out of a pen): the rule should be to close every gate or door after passing, on every path: [Opening ordinary doors, known issues](features/world/opening-ordinary-doors.md), with the pen side in [Animal farming, known issues](features/farming/animal-farming.md). Fixed in [Phase 26](DEVELOPMENT-PLAN/phases/closing-doors-behind.md).
- **Cave sealing put cobblestone inside a quarry's space**, and an excavation is never verified against its plan (no shape, seal, or extra-block check): [Excavation](features/world/excavation.md). Fixed in [Phase 27](DEVELOPMENT-PLAN/phases/excavation-reliability.md).
- **Several furnaces cannot be placed above the bot's feet level** (agent's diagnosis: no placing higher than its own feet): [Construction and building](features/world/construction-and-building.md). Fixed in [Phase 29](DEVELOPMENT-PLAN/phases/placement-fixes.md).
- **`place_sign` on a fence top fails to walk to the spot** (routes through an unrelated gate), and a torch on the fence gives no alternative: [Signs](features/world/signs.md). Fixed in [Phase 29](DEVELOPMENT-PLAN/phases/placement-fixes.md).
- **Gravel and sand stop a dig for good** (`falling_blocks`): [Excavation](features/world/excavation.md). Fixed in [Phase 27](DEVELOPMENT-PLAN/phases/excavation-reliability.md).
- **No way to dig a route to a specific ore** (`dig_to`): [Excavation](features/world/excavation.md). Fixed in [Phase 27](DEVELOPMENT-PLAN/phases/excavation-reliability.md).

## Maintenance
- **`npm audit`** reports moderate issues in Mineflayer's authentication dependencies. They are upstream and unused in offline mode; revisit when Mineflayer updates them.
- **Node and testcontainers**: `testcontainers` is pinned to 11 because 12 needs Node 22.28 or newer. Revisit when the Node baseline moves.
