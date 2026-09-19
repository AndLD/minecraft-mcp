# Backlog

Ideas, deferred work, and known gaps that are not in [DEVELOPMENT-PLAN.md](DEVELOPMENT-PLAN.md) yet. Nothing here is committed to: an item moves into the plan (with its own `feature/<name>` branch) when it is picked.

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

## Deferred from finished work

### Survival reflexes
- **Fall-damage guard**: land in water with a bucket, or avoid the fall. Needs placing blocks and buckets, so it fits after the building work. The pathfinder's default maximum drop already avoids large falls.
- **Night shelter**: build or dig in when night falls far from a bed. Same dependency.
- **E2E scenario for a reflex pausing and resuming a real task**: covered by integration tests only.

### Gathering, crafting, smelting
- **Blast furnace and smoker**: `smelt` only uses a regular furnace (twice as slow for ores and food).
- **Reaching high logs**: tall tree trunks cannot be finished from the ground because the bot never pillars up. Options: allow towering with a safe block, or leave the top logs.
- **Bare-floor mining**: asking for `stone` on a stone floor digs the floor blocks next to the bot (never the one underfoot). A "surface only" or "walls only" option could keep the ground intact.
- **`InventoryWriter` port**: planned with the handover feature (equip, toss).

## Maintenance
- **`npm audit`** reports moderate issues in Mineflayer's authentication dependencies. They are upstream and unused in offline mode; revisit when Mineflayer updates them.
- **Node and testcontainers**: `testcontainers` is pinned to 11 because 12 needs Node 22.28 or newer. Revisit when the Node baseline moves.
