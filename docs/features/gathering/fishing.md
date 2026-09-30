# Fishing

**Depends on:** [Movement and perception](../../DEVELOPMENT-PLAN/phases/movement-perception.md) (walking, facing a point), [Gathering, crafting, smelting](gathering-crafting-smelting.md) (`smelt` cooks the catch), [Hunting and food](hunting-and-food.md) (the food policy), [Tasks](../core/tasks.md), [Storage](../storage/storage.md) (optional: the storage rules place the catch when the player asks).  
**Used by:** [Hunting and food](hunting-and-food.md) (the `fish_and_cook` low-food policy).

Branch `feature/fishing`. "Catch me 10 fish": the bot finds a pond, stands on the shore, casts, waits for the bite, reels in, and counts what came up.

## Tool

`fish` (a task): `count` (fish wanted, 1-200, default 10), `item` (count only this catch, for example `salmon`; everything else is kept but does not count), `max_minutes` (1-60, default 10), `cook` (bake the raw fish afterwards with `smelt`, default false), `at` (x, y, z: fish at water near there, instead of the nearest water).

Result: `stopped` (`count`, `time`, `rod_broke`, `inventory_full`, `cast_failed`), `caught` (towards the goal), `fish`, `treasure`, `junk`, `casts`, `gained` (everything the inventory gained), `spot` (where it stood and cast), `cooked`, and `cookProblem` when baking failed (the fishing itself succeeded). Failures: `no_rod` (the message says a rod is 3 sticks and 2 string; the tool never crafts one), `no_water`, `unreachable`, `not_connected`, `aborted` (with what was caught so far).

## How it works

- **`Fisher` port** (`src/core/fisher.port.ts`, `MineflayerFisher`): takes the rod in hand, calls `bot.fish()` (which casts, waits for the bite, and reels in), and returns. Aborting the signal pulls the line in (using the rod again), which ends the pending cast.
- **`findFishingSpot`**: open water at least 3 by 3 blocks wide with air on top of the middle (a one-block stream and covered water are refused), and firm ground of the same level 2 to 4.5 blocks away with room for the bot, outside protected areas and with no lava beside it. The nearest such water wins, and among its standing places the one nearest to the bot. It never enters the water.
- **`FishSkill`**: check the rod, walk to `at` (when given), find the spot, walk to it, then loop: stop when the count is reached, time is up, the rod is gone (`rod_broke`), or no slot is free (`inventory_full`); face the water; cast; a cast with no bite in 60 seconds is reeled in and thrown again (through the injected `Scheduler`, so a test does not wait a minute); read what came up from the **inventory difference** after a second. Three casts in a row that fail for another reason end the task (`cast_failed`).
- **What counts.** Fish (cod, salmon, pufferfish, tropical fish) count towards `count`; the catch table (`catch-table.ts`) sorts the rest into treasure (name tag, saddle, nautilus shell, enchanted book, bow) and junk. With `item`, only that item counts.
- **`fish_and_cook` food policy.** `set_food_policy` takes a fourth value next to `ask`, `hunt_and_cook`, and `stop`: when the bot is hungry with nothing to eat, `LowFoodResponder` starts `fish` (5 fish, cooked) through the tool registry, like the hunt. The default stays `ask`.

## Gotchas

- Bites are random: a run can take minutes, and a 10-fish request usually takes 5 to 10 minutes. The task is polled like any other.
- The bot fishes on the surface from the shore only. It does not row a boat, and it does not keep watch for mobs or the night while it fishes (the survival reflexes still act and pause the task).
- A full inventory ends the task (`inventory_full`) rather than following the `on_inventory_full` policy of the storage tools.
- The rod wears out; the task ends `rod_broke` with the catch so far, and a spare rod is not swapped in.

## Tests

- **Unit:** the spot finder (stand level and distance, nearest place, a one-block stream, covered water, protected area, lava, no water), the skill on a stateful pond (`test/fakes/fishing-fakes.ts`: count reached, sorting, `item`, a cast that never bites and is recast, time, rod breaking, full inventory, three failed casts, cooking and a cooking problem, no rod, not connected, no water, unreachable, `at`, cancelling while waiting), the adapter against the fake bot (cast, reel in on abort, no rod), the tool, `LowFoodResponder` and `set_food_policy` for `fish_and_cook`.
- **E2E** (`test/e2e/fishing/`, real Paper): a pond dug through RCON and a rod given by RCON: the bot walks to the shore, casts, and catches a fish (bites are random, so the test allows minutes and only asks for one fish); `no_rod` names the sticks and string; `no_water` when there is no pond.
