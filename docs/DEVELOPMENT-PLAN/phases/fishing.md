# Phase 35: Fishing

_Estimate: 1 session._  
**Status:** done on `feature/fishing`. See [Fishing](../../features/gathering/fishing.md). Differences from this plan: a full inventory ends the task (`inventory_full`) instead of following `on_inventory_full`; `spot` is coordinates (`at`), not a landmark; the task ends with a result and `stopped` (`rod_broke`, `time`, ...) instead of an error; no early stop for night or hostile mobs (the reflexes still act); `count` counts fish, or only `item` when given.

**Depends on:** [3 Movement and perception](movement-perception.md), [7 Gathering, crafting, smelting](gathering-crafting-smelting.md) (crafting a rod, cooking the catch), [8 Hunting and food](hunting-food.md) (the food policy and the low-food response), [9 Storage and containers](storage-containers.md) (optional: depositing the catch), [30 World discovery](world-discovery.md) (optional: finding water).  
**Needed by:** [42 Hardening and polish](hardening-polish.md).

Fishing is food and loot: fish, and with luck treasure and junk. It comes from the backlog item "Fish and other food". "Catch me 10 fish" or "fish until I say stop" should work without the player touching anything.

- Branch: `feature/fishing`. A `FishSkill` (`fish`) in `src/skills/fishing/`, and a `Fisher` port in `src/core/` (cast, wait for the bite, reel in, report what came up) with a thin `MineflayerFisher` adapter in `src/bot/`. Skills never see Mineflayer.
- **Tool `fish`:** `count` (catches wanted, default 10), `item` (a kind of catch to stop on, for example `cod`; other catches are kept), `max_minutes` (default 10), `cook` (bake the raw fish in a furnace when done, default false), and `spot` (a landmark or coordinates; default: the nearest suitable water). A task with progress and a result: `caught` (per item), `junk`, `treasure`, `casts`.
- **The rod.** It needs a fishing rod: with none it fails `no_rod` naming what to craft (3 sticks and 2 string; string is not craftable, so the message says to find it (spiders, cobwebs, or chests)), and it never crafts on its own except when the player asked for it. A rod wears out: when it breaks the task ends `rod_broke` with the catch so far.
- **The spot.** A standing place on solid ground next to open water at least 3 blocks wide (open sky above the water is preferred but not required). It faces the water and casts. Water only one block wide, lava, or a spot in a protected area is refused. It never enters the water and never walks along a drop.
- **The loop.** Cast, wait for the bite (the injected `Scheduler` and `Clock` bound each wait; a cast that has not bitten in 60 seconds is reeled in and recast), reel in, read the new item from the inventory delta, repeat. The catch is counted against `count`. A full inventory follows the usual `on_inventory_full` policy (ask, offload and return, or stop).
- **Safety.** The survival reflexes act as always and pause the task; the bot stays out of the water and away from mobs it cannot see. Night and hostile mobs nearby end a long session early (`unsafe`), the same way other long tasks do.
- **Food policy.** `LowFoodResponder` and the food policy gain a way to fish: a `fish_and_cook` option next to `hunt_and_cook`, used only when the player has set it. The default stays as it is (ask).
- **Docs and tools table.** A feature page `docs/features/farming/fishing.md` (or the hunting group, whichever holds "food"), a row in `FEATURES.md`, the `fish` tool in the AGENTS.md tool table, and a runtime-protocol item.
- **Tests:**
  - unit: the skill over a fake `Fisher`, `Clock`, and `Scheduler` (count reached, `item` reached, bite timeout and recast, rod missing, rod breaks, no water, water too small, protected area, full inventory under each policy, abort, `max_minutes`, cooking), the spot finder, and the adapter against a stub of the Mineflayer API
  - integration: `fish` through the tool layer on a stateful fake world with a scripted bite schedule, ending with the catch counted and deposited by the storage rules
  - e2e (`test/e2e/fishing/`): a pond dug through RCON and a rod given by RCON; the bot casts and catches at least one item. Bites are random on a real server, so the test allows a long timeout and checks the inventory delta, not a count, and one case checks `no_rod`
- **Exit criteria:** with a rod and a pond, "catch 10 fish" walks to a good spot, fishes until 10 fish are in the inventory (or says why it stopped), reports what else it caught, and optionally cooks the fish.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
