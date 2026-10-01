# Backlog

Ideas, deferred work, and known gaps that nobody has picked yet: **not built and not in the plan**. Everything that was built is in [COMPLETED-BACKLOG.md](COMPLETED-BACKLOG.md). The plan for what is being built is [DEVELOPMENT-PLAN.md](../DEVELOPMENT-PLAN/DEVELOPMENT-PLAN.md).

This page is the index. Each area has its own file under [features/](features/), like the phases of the plan, and says what an item is, why it might be worth doing, and what is known about the approach.

**How it is kept:**
- An item stays here until someone picks it. Then it moves into the plan (with its own `feature/<name>` branch and a phase page) and is **removed from the backlog**: the plan is the one place that tracks it. If an area file still holds other items it keeps a one-line pointer to the phase.
- When an item is **built**, it is written into [COMPLETED-BACKLOG.md](COMPLETED-BACKLOG.md) with the phase or feature that built it (if it ever was in the backlog or noted as left out). A file with nothing left in it is deleted and its row removed.
- New ideas, and gaps found while building a phase, are added to the file of their area (or a new file with a row here).

## Features

| Idea |
|---|
| [Voice instructions](features/voice-instructions.md): speak to the bot instead of typing (push-to-talk companion) |
| [Several bots managed by one agent](features/multiple-bots.md): N bots in one world |
| [Autonomy: the bot's own will](features/autonomy.md): goals, needs, and an engine that works on its own |
| [Farming extras](features/farming-extras.md): bee nest moving, sugar cane, bamboo, cocoa, nether wart, redstone auto-farms |
| [Several connected rooms in one request](features/connected-rooms.md): a `rooms` layout for `excavate` |
| [Boats](features/boats.md): crossing and fishing on open water |

## Gaps in finished features

| Area | Left out |
|---|---|
| [Survival reflexes](features/survival-reflexes.md) | fall-damage guard; night handling (a shelter, and long tasks stopping for night and mobs); an e2e for a reflex pausing a task |
| [Hunting and food](features/hunting-and-food.md) | leashed animals; other pen materials; foraging |
| [Gathering](features/gathering.md) | bare-floor mining |
| [Storage](features/storage.md) | craft and place a new chest; carried ender chests and shulker boxes; measured free space |
| [Railways](features/railways.md) | junctions and crossings; detector and activator rails |
| [Discovery and caves](features/discovery-and-caves.md) | a shipwreck signature; buried blocks in signatures; mobs and other dimensions in biome-guided search |
| [Fishing](features/fishing.md) | a spare rod; the full-inventory policy; fishing at a landmark |
| [Smelting](features/smelting.md) | crafting a blast furnace or a smoker when none stands nearby (using them is built, [Phase 42](../DEVELOPMENT-PLAN/phases/blast-furnace-smoker.md)); nuggets; fuel from storage mid-job; a distance limit |

## Maintenance

| Item | Status |
|---|---|
| [Dependencies and versions](features/maintenance.md): `npm audit` in Mineflayer's auth dependencies; `testcontainers` pinned to 11; biome tables for other Minecraft versions | ongoing |
