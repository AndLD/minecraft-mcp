# Phase 42: Blast furnace and smoker

_Estimate: ½ session._  
**Status:** done on `feature/blast-furnace-smoker`. See [Gathering, crafting, smelting](../../features/gathering/gathering-crafting-smelting.md).

**Depends on:** [7 Gathering, crafting, smelting](gathering-crafting-smelting.md) (`SmeltItemsSkill`, `Workstations`, `FurnaceAccess`), [36 Smelting wait strategy](smelting-wait.md) and [41 Smelting, fuel top-up and a ready signal](smelting-fuel-and-ready.md) (jobs, the ready signal, fuel).  
**Needed by:** [48 Hardening and polish](hardening-polish.md).

`smelt` used only the plain furnace. A blast furnace smelts ores and raw metals in half the time, and a smoker cooks food in half the time; both burn fuel at the furnace's rate, so the same fuel goes twice as far. It comes from the backlog item "Blast furnace and smoker".

- Branch: `feature/blast-furnace-smoker`. No new tool: `smelt` gets `station` and the skill learns the three blocks.
- **Stations** (`stations.ts`): `furnace` (everything in the smelting table, 10 s per item), `blast_furnace` (ores and raw metals: raw iron, gold, and copper, their ores, ancient debris; 5 s per item), `smoker` (food and kelp: beef, porkchop, mutton, chicken, rabbit, cod, salmon, potato, kelp; 5 s per item). `stationSmelts(station, item)` says what each can do.
- **`station: 'auto'` (default).** A blast furnace or smoker that stands within 32 blocks or is carried is used when it can smelt the item; otherwise a furnace, crafted when there is none, as before. So cooking after a hunt or a fishing trip, and smelting ore, become faster by themselves when the player has built the right block. `station: 'furnace' | 'blast_furnace' | 'smoker'` names one: a station that cannot smelt the item fails `wrong_station`; a blast furnace or smoker that is not there fails `no_blast_furnace` or `no_smoker`, saying what it is made of (they are **not** crafted on the way: a blast furnace costs 5 iron ingots).
- **Speed everywhere.** The station's time per item is used for the wait (the poll interval and the timeout), for the `smelt_ready` estimate (the job records its `station`), and for the fuel: `chooseFuel`, `totalFuelCapacity`, the top-up, and the fuel fetched from storage take a `speed` (2 for a blast furnace and a smoker), so one coal smelts 16 items there. The result says which block smelted it (`station`).
- **The adapter** opens all three windows (`MineflayerFurnaceAccess` accepted only names ending in `furnace`, which left the smoker out).
- **Not built:** crafting a blast furnace or a smoker; the campfire (a different mechanic: no window and no fuel; planned as [Phase 43](campfire-cooking.md)); tools and armor smelted into nuggets in a blast furnace (the smelting table does not have them).
- **Tests:**
  - unit: the station table (what each smelts, the auto order), `chooseFuel` and `totalFuelCapacity` with `speed`, the skill (auto picks a nearby or carried blast furnace for iron and a smoker for beef, a furnace for the rest and when none stands, naming a station, `wrong_station`, `no_smoker`, the faster wait and timeout, twice the items per fuel, the job records its station and the ready estimate uses it), fuel from storage with `speed`, the adapter (a smoker opens), the tool option
  - integration: `smelt` through the tool layer on a fake bot with a blast furnace beside it: 6 raw iron are done in half the time, and `smelt_ready` comes at the shorter estimate
  - e2e (`test/e2e/gather-craft-smelt/`): a blast furnace and a smoker placed through RCON: raw iron is smelted in the blast furnace and beef cooked in the smoker on a real server, each in about half the furnace time
- **Exit criteria:** with a blast furnace or a smoker beside the bot, "smelt my iron" and "cook the beef" use it without being told and finish in half the time; without one nothing changes.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
