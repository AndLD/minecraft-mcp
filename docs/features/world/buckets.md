# Filling buckets

**Depends on:** [Tasks](../core/tasks.md) (`fill_bucket` is a task), [Construction and building](construction-and-building.md) (`WORK_REACH` from the standing-spot search), [Gathering, crafting, smelting](../gathering/gathering-crafting-smelting.md) (protected areas, `craft bucket`), [Survival reflexes](../survival/survival-reflexes.md) (`AvoidLava` and `Drowning` stay active the whole time).  
**Used by:** no other feature directly. It removes a hand-off: anything that places water (crop fields, water landings) needed a `water_bucket` that the player had to supply.

Branch `feature/buckets`. One tool, `fill_bucket`: "fill a bucket with water" and "get me a lava bucket". Nothing else about buckets is new: putting a liquid back is `place_block` with the bucket, milk is a cow, and fish, axolotl, and powder snow buckets are not handled.

## Tool

`fill_bucket` (a task): `liquid` (`water` or `lava`), `count` (1 to 16, default 1, limited by the empty buckets carried), optional `at` (a source block's coordinates), `max_distance` (default 24, ignored with `at`). The reply has `item`, `filled`, `requested`, `from` (the blocks taken), `poolRefills` (water only), `stoppedBecause` (when it took fewer than asked), and a `message`.

Failures (`reason`): `no_bucket` (with what to craft: 3 iron ingots; it never crafts on its own), `inventory_full`, `no_source`, `not_a_source`, `protected_area`, `structure_nearby`, `no_safe_spot`, `unreachable`, `aborted`, `failed`. A run that filled at least one bucket and then met a problem is a **success with `stoppedBecause`**, so a bucket already full is never reported as a failure.

## How it works

- **Only a source block fills a bucket.** `BlockScanner` finds blocks by name, which includes flowing cells, so every candidate is read again through `LiquidReader.liquidAt`: the blockstate `level` is 0 for a source, 1 to 7 for flowing water, and 8 and up for falling. A missing `level` counts as flowing (nothing proves otherwise). The reply distinguishes "no water", "only flowing water", and "the block you named is flowing / the other liquid / not a liquid".
- **The pond stays.** A water cell with **two water sources beside it** (on its sides, with ground or water below) is made again by the game, so `poolRefills` is worked out **before** the take from those neighbours: a 2x2 pool or a bigger one refills, a single block or a pool of two does not (each block has only one neighbour). The search prefers a refilling source when one is at most 6 blocks further than the nearest. Lava never refills.
- **Where the bot stands** (`LiquidSpotFinder`): solid ground, a free head cell, the source within 4 blocks of the eyes, and a **clear line to it** (sampled every 0.2 blocks; a solid block in between would take the click). Feet may be in shallow water (a source is often only reachable from flowing water) at a small extra cost; a head under water, a ladder, or lava is not allowed. The current place is kept when it fits. After each walk the spot is chosen again from where the bot really ended up (up to 3 tries).
- **The click** (`MineflayerBucketFiller.fill`): hold an empty `bucket`, look at the centre of the source (forced), `activateItem`, then wait up to 8 ticks for the inventory to gain the `water_bucket` or `lava_bucket`. Success means the count of the filled item really went up.
- **Other items are never touched.** A `water_bucket` that is carried stays in the inventory, so `AvoidLava` still has something to work with. A filled bucket needs a slot of its own, so with no free slot and more than one empty bucket the run fails `inventory_full` up front.

## Lava is guarded

- **Protected area:** refused (`protected_area`), for water too, **even when the block is named**.
- **Player-built blocks within 4 blocks of the source:** refused (`structure_nearby`, with the block's name and place in `detail`) **unless the player named the source with `at`**. "Player-built" is a name list (`isPlayerBuilt` in `bucket-table.ts`: planks, stairs, slabs, fences, doors, bricks, glass, wool, chests, furnaces, torches, signs, beds, rails, and the like); natural stone, obsidian, netherrack, basalt, and gravel are not on it, since they are what lava lies in. Lava is often part of a build (a farm, a trap, a lit pit), which is why the player has to name the block.
- **The standing spot** (strict for lava): no lava within one block around it, from one block below its feet up to four blocks above (so lava cannot flow onto it, drip onto it, or lie beside it), and the source must not be higher than the head (taken from the side, never from below). An unloaded cell counts as unsafe. No such spot within reach is `no_safe_spot`.
- **Re-read before every take.** Each bucket starts with a fresh search and a fresh spot, and after each lava take the bot's own spot is checked again: if lava has flowed next to it, the run stops there with `stoppedBecause` (the bucket already filled is kept) and the lava reflex looks after the bot.
- Lava is only taken when the caller asked for `liquid: lava`; no other tool does it as a side effect.

## Ports and adapters

- `LiquidReader` and `BucketFiller` (`src/core/bucket.port.ts`), both implemented by `MineflayerBucketFiller` (`src/bot/mineflayer-bucket-filler.ts`).
- `FakeBot` simulates it (`setLiquidLevel`, `bucketsFilled`, an empty bucket used on a source becomes the filled one, water made again beside two sources); `BucketWorld` (`test/fakes/bucket-fakes.ts`) is the stateful fake for skill tests.

## Tests

- unit: `MineflayerBucketFiller` (source, flowing, and falling levels as number and as string, a missing level, no bucket, out of reach, a thrown call, no fill, abort), `LiquidSpotFinder` (staying put, walls, unloaded ground, shallow and flowing water, the strict lava rules), `isPlayerBuilt`, `FillBucketSkill` (nearest source, refilling versus drained, `at`, several buckets, partial results, `no_bucket`, `inventory_full`, flowing cells, protected area, walk failure, abort, every lava rule, and that a carried water bucket is untouched), `FillBucketTool`.
- integration (`test/integration/buckets-flow.test.ts`): the tool through the MCP server on the fake bot's world: a 2x2 pond that stays, a lone source drained and flowing water skipped, lava from a pool, `structure_nearby` then allowed by `at`, a protected area, `no_bucket`.
- e2e (`test/e2e/buckets/buckets.e2e.test.ts`, real Paper): a pond filled and whole again a moment later (the exit criterion), flowing water refused when named and skipped when searching, lava from a 3x3 pool with no lava beside the bot and its health unchanged, `structure_nearby` then allowed, a protected area, and `no_bucket`.

## Gotchas found on the real server

- A pool taken from is whole again only **a few ticks later**: check with a wait, not at once.
- Water lying on the ground floods a whole plate of flowing cells around it, all at the bot's own level, so the only places within reach are wet. That is why shallow water is allowed under the feet.

## Not built

Reusing the filler for excavation's water landing or crop-field water, and the fall-damage guard in [the backlog](../../BACKLOG.md), which needs a full bucket in hand. Neither is part of this feature.

## Exit criteria

"Fill a bucket with water" from a pond gives a `water_bucket` and the pond stays; "get me a lava bucket" from a lava pool fills one without the bot ever standing where the lava could reach it, and refuses inside a protected area; with no empty bucket it says exactly what to craft.

[Back to the features index](../FEATURES.md)
