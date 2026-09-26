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

### Farming extras

Left out of the farming feature in the plan: shearing sheep, milking cows, honey (collecting eggs is now part of `feature/animal-farming`); sugar cane, bamboo, melons, pumpkins, cocoa, nether wart; composters; redstone auto-farms (observers, pistons, hoppers).

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

Bugs and gaps found while playing, each written up with the cause and fix ideas under "Known issues" in the feature's own document. Each one moves into the plan (with a `fix/<name>` or `feature/<name>` branch) when it is picked.

- **`lure_animals` reports `penFull` when nothing could be led** and loses chickens that the bot outruns: [Animal farming, known issues](features/farming/animal-farming.md).
- **Extra grass inside a freshly built pen** leaves cells that are not free, and the pen's own protected area stops the bot from clearing them: [Animal farming, known issues](features/farming/animal-farming.md).
- **A crop field's single water source leaves the far rows dry** on a 7x7 field: [Animal farming, known issues](features/farming/animal-farming.md).
- **`place_sign` on a fence top fails to walk to the spot** (routes through an unrelated gate), and a torch on the fence gives no alternative: [Signs, known issues](features/world/signs.md).
- **Gravel and sand stop a dig for good** (`falling_blocks`): [Excavation, known issues](features/world/excavation.md).
- **No way to dig a route to a specific ore** (`dig_to`): [Excavation, known issues](features/world/excavation.md).

## Maintenance
- **`npm audit`** reports moderate issues in Mineflayer's authentication dependencies. They are upstream and unused in offline mode; revisit when Mineflayer updates them.
- **Node and testcontainers**: `testcontainers` is pinned to 11 because 12 needs Node 22.28 or newer. Revisit when the Node baseline moves.
