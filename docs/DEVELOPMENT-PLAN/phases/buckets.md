# Phase 22: Filling buckets with water and lava

_Estimate: ½ session._

**Depends on:** [3 Movement and perception](movement-perception.md), [7 Gathering, crafting, smelting](gathering-crafting-smelting.md) (an empty bucket is crafted from iron), [13 Construction engine and building](construction-building.md) (`SiteSafety`, the standing-spot search).  
**Optional:** [14 Excavation and mining](excavation-mining.md) (the hazard rule is the model for the lava checks).  
**Needed by:** no later phase depends on it directly. It removes a hand-off that exists today: crop fields, water landings, and any plan that places water all need a `water_bucket` that the player has to supply, because the bot cannot fill one.

The bot can only place a full bucket (`MineflayerPlacer` already uses one as a bucket, not as a block). Nothing takes water or lava from the world into an empty bucket, so a bot without a filled bucket cannot make a water source at all. This phase adds that one action and keeps it safe, especially for lava.

- Branch: `feature/buckets`. A new small port (`BucketFiller`: fill an empty bucket from the liquid source at a position; aborting stops it) with a `MineflayerBucketFiller` adapter, and one skill, `FillBucketSkill`, that finds the source, walks to a safe standing spot next to it (the `StandingSpotChooser`), and confirms the bucket really became `water_bucket` or `lava_bucket`. It is a client of `Navigator`, `BlockScanner`, `InventoryReader`, and `AreaGuard`, and needs no engine.
- **Tool `fill_bucket`:** `liquid` (`water` or `lava`), `count` (default 1, limited by the empty buckets carried), optionally `at` (a source block's coordinates; otherwise the nearest source within `max_distance`). Only a **source** block fills a bucket: a flowing cell gives nothing, so the search looks at the block's level, not just its name. With no empty bucket it fails with `no_bucket` and says what to craft (3 iron ingots), rather than crafting on its own.
- **Water:** taking one source from a pool is enough for one bucket; a pool with two sources next to each other refills itself, so taking from it does not drain it. The reply says which case it was.
- **Lava is the risky one.** Rules: never stand where lava could flow onto the standing spot (the bot works from a dry, solid block with no lava on the same level or above it, and takes the source from the side, not from above); refuse in a protected area; refuse when a player-built structure is within a few blocks of the source unless the player named the block; keep a `water_bucket` free in the inventory when one is carried, so the reflex to leave lava has something to work with; after each take, re-read the surroundings, because removing a source can let neighbouring lava flow into the gap. `AvoidLava` and `Drowning` stay active the whole time (reflexes do not depend on the task). Lava is only taken when the player asked for it in words, never as a side effect of another tool.
- **What it does not do:** milk (a cow is farming), powder snow, fish or axolotl buckets, and putting a liquid back (`place_block` with a bucket already does that).
- **Reuse later:** excavation's water landing and crop-field water could fetch their own bucket; the fall-damage guard in [the backlog](../../BACKLOG.md) (land in water) needs a full bucket in hand. Neither is part of this phase.
- Tests:
  - unit: `MineflayerBucketFiller` against a stub (empty bucket in hand, look at the source, activate, the item changes; `not_connected`, `no_bucket`, a flowing cell is refused, a thrown call wrapped as `failed`), `FillBucketSkill` (nearest source, `at`, several buckets, `no_source`, `no_bucket`, protected area, lava rules: no safe standing spot, a structure nearby, re-check after each take, abort mid-way)
  - integration: `fill_bucket` through the tool layer on a fake world: water pool, single source versus two sources, lava with the safety refusals
  - e2e: a water pool and a small lava pool built over RCON; the bot fills a bucket from each and the carried item changes; a flowing cell yields nothing; lava next to a placed block is refused
- **Exit criteria:** "fill a bucket with water" from a pond gives a `water_bucket` and the pond stays; "get me a lava bucket" from a lava pool fills one without the bot ever standing where the lava could reach it, and refuses inside a protected area; with no empty bucket it says exactly what to craft.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
