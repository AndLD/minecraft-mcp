# Backlog

Ideas, deferred work, and known gaps that are **not built yet**. Everything that was built is in [COMPLETED-BACKLOG.md](COMPLETED-BACKLOG.md). The plan for what is being built is [DEVELOPMENT-PLAN.md](DEVELOPMENT-PLAN/DEVELOPMENT-PLAN.md).

This page is the index. Each area has its own file under [backlog/](backlog/), like the phases of the plan, and says what an item is, why it might be worth doing, and what is known about the approach.

**How it is kept:**
- An item is **unplanned** until someone picks it. Then it moves into the plan (with its own `feature/<name>` branch and a phase page), and its row here says **planned**, with the phase.
- When an item is **built**, it is removed from its file here and written into [COMPLETED-BACKLOG.md](COMPLETED-BACKLOG.md) with the phase or feature that built it. A file with nothing left in it is deleted and its row removed.
- New ideas, and gaps found while building a phase, are added to the file of their area (or a new file with a row here).

## Features

| Idea | Status |
|---|---|
| [Voice instructions](backlog/voice-instructions.md): speak to the bot instead of typing (push-to-talk companion) | not planned |
| [Several bots managed by one agent](backlog/multiple-bots.md): N bots in one world | not planned |
| [Autonomy: the bot's own will](backlog/autonomy.md): goals, needs, and an engine that works on its own | not planned |
| [Farming extras](backlog/farming-extras.md): shearing, milking, melons, composter and bone meal; honey, sugar cane, bamboo, cocoa, nether wart, redstone farms | Phases [44](DEVELOPMENT-PLAN/phases/farming-extras.md) and [45](DEVELOPMENT-PLAN/phases/composter-bone-meal.md) planned; the rest not planned |
| [Several connected rooms in one request](backlog/connected-rooms.md): a `rooms` layout for `excavate` | not planned |
| [Take an item the player hands over](backlog/receive-item.md): `receive_item` | planned, [Phase 46](DEVELOPMENT-PLAN/phases/receive-item.md) |

## Gaps in finished features

| Area | Left out | Status |
|---|---|---|
| [Survival reflexes](backlog/survival-reflexes.md) | fall-damage guard, night shelter, an e2e for a reflex pausing a task | not planned |
| [Hunting and food](backlog/hunting-and-food.md) | campfire cooking; leashed animals; other pen materials; foraging | campfire planned ([Phase 43](DEVELOPMENT-PLAN/phases/campfire-cooking.md)), the rest not planned |
| [Gathering](backlog/gathering.md) | bare-floor mining | not planned |
| [Storage](backlog/storage.md) | craft and place a new chest; carried ender chests and shulker boxes; measured free space | not planned |
| [Railways](backlog/railways.md) | junctions and crossings; detector and activator rails | not planned |
| [Discovery and caves](backlog/discovery-and-caves.md) | night, a shipwreck signature, buried blocks in signatures, mobs and other dimensions in biome-guided search, boats, more version tables | not planned |
| [Fishing](backlog/fishing.md) | a boat, a spare rod, the full-inventory policy, night and mobs | not planned |
| [Smelting](backlog/smelting.md) | crafting a blast furnace or a smoker, nuggets, fuel from storage mid-job, a distance limit | not planned |

## Maintenance

| Item | Status |
|---|---|
| [Dependencies](backlog/maintenance.md): `npm audit` in Mineflayer's auth dependencies; `testcontainers` pinned to 11 | ongoing |
