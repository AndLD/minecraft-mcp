# Phase 43: Campfire cooking

_Estimate: ½ session._  
**Status:** not started.

**Depends on:** [7 Gathering, crafting, smelting](gathering-crafting-smelting.md) (`smelt`, the stations, `Workstations`), [42 Blast furnace and smoker](blast-furnace-smoker.md) (`station` and the station table), [8 Hunting and food](hunting-food.md) (cooking after a hunt), [Tasks](../../features/core/tasks.md).  
**Needed by:** [47 Hardening and polish](hardening-polish.md).

A campfire cooks raw food **without fuel**: up to four items at a time, 30 seconds each, right on the block. It is slower than a furnace or a smoker (a full campfire finishes four items in 30 seconds, so 7.5 seconds each, but the food has to be put on and picked up by hand) but it needs no coal and no window. It is the natural way to cook after a hunt far from home, and a player often keeps one next to a pen. It comes from the backlog note on campfires (the blast furnace and smoker phase left it out because it is a different mechanic: no window, no fuel).

- Branch: `feature/campfire-cooking`. A `CampfireCookSkill` and a new station `campfire` (a soul campfire cooks the same way, so it counts as the same station) in `stations.ts`; `smelt` gets `station: 'campfire'` and `auto` learns to use it. No new tool.
- **How cooking works.** Not a window. The bot faces the campfire and uses a raw food item on it (`Placer`-like click with the item in hand: the same right-click as placing an item on a block, through a small `CampfireAccess` port: `put(position, item)` returns whether it went on and `slots(position)` reads the four slots from the block entity when it can, otherwise from what was put and when). An item cooks for 30 seconds and then **pops out as a dropped item** beside the fire, which the bot picks up with the existing `DropCollector`. A lit campfire is needed (not one that was put out by water or rain; the bot checks the `lit` blockstate) and the bot never stands on it.
- **What it cooks.** Food only: beef, porkchop, mutton, chicken, rabbit, cod, salmon, potato (kelp is not, it is smoker only). `stationSmelts('campfire', item)` says which.
- **The loop.** Put up to 4 items on the free slots, wait (the closed-loop wait of the smelt job: no standing over it; the injected `Scheduler` and `Clock`), pick up what popped out, put the next items on, and go on until everything is cooked or the time limit passes. A wait of 30 seconds is one look, so the job is short; a big batch (64 beef) takes 8 minutes, and the bot may be told to leave it (see below).
- **`auto`.** For food: a smoker that stands nearby or is carried first (fastest, but it burns fuel), then a **campfire nearby when the bag has no usable fuel** or the batch is small (up to 8 items), then a furnace. `station: 'campfire'` names it. A campfire is never placed or crafted on the way (a campfire needs 3 sticks, 1 coal or charcoal, and 3 logs; the failure says so, like the blast furnace).
- **Jobs.** A cut-short campfire job cannot be left cooking safely (the items are on the block and pop out into the world after 30 seconds, where they despawn in five minutes), so the wait is **not** interruptible into a job record: cancelling takes back what is still on the fire, if the server allows it (an item on a campfire can be taken by right-clicking with an empty hand), and picks up what has popped out. The `smelt_ready` signal does not apply.
- **Safety.** Never on a campfire in a protected area (it is a player build); the bot stands on a free cell beside it, not on a fire, and steps away from a fire that is burning under it. Cooking near lava or water follows the `HazardRule` used for placing.
- **Docs.** The gathering, crafting, and smelting page, the hunting and fishing pages (cooking uses `smelt`), AGENTS.md (the `station` note), the backlog entry.
- **Tests:**
  - unit: the station table (what a campfire cooks, the auto order with and without fuel, small and big batches), the skill over a fake `CampfireAccess` and drops (four at a time, the wait, picking up what pops out, a fire that is out, a full campfire waiting for a slot, cancel taking the items back), the adapter against the fake bot
  - integration: `smelt` through the tool layer with a campfire beside the bot and no fuel: 4 raw chicken are cooked and picked up
  - e2e (`test/e2e/gather-craft-smelt/`, extended): a campfire placed through RCON and raw beef given: the bot puts four on it, waits, and ends with the cooked beef (about a minute and a half for 8 items)
- **Exit criteria:** "cook this beef" with a campfire beside the bot and no coal cooks it there and brings it back, and with a smoker or a furnace and fuel nothing changes.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
