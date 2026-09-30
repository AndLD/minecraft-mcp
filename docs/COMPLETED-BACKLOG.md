# Completed backlog

Ideas, deferred work, and known gaps from the [backlog](BACKLOG.md) that have been **built**, with where. What is still open is in the backlog.

## Features

- **Fishing** (was "Fish and other food": only livestock was huntable): [Fishing](features/gathering/fishing.md), [Phase 35](DEVELOPMENT-PLAN/phases/fishing.md). Foraging is still open (see [Hunting and food](backlog/hunting-and-food.md)).
- **Organizing what is already in the chests** (`OrganizeStorage`): [Storage](features/storage/storage.md), [Phase 37](DEVELOPMENT-PLAN/phases/organize-storage.md).
- **Blast furnace and smoker** (`smelt` used a regular furnace only): [Gathering, crafting, smelting](features/gathering/gathering-crafting-smelting.md), [Phase 42](DEVELOPMENT-PLAN/phases/blast-furnace-smoker.md).
- **Reaching high logs** (tall trees could not be finished from the ground): [Tree farming](features/farming/tree-farming.md), [Phase 34](DEVELOPMENT-PLAN/phases/tall-trees.md), and cutting the leaves in the way in [Phase 39](DEVELOPMENT-PLAN/phases/tall-tree-leaves.md).
- **Cooked food into chests** (deposit the cooked food once storage existed): `deposit_cooked` on `hunt_animals`, see [Hunting and food](features/gathering/hunting-and-food.md).
- **The `InventoryWriter` port** (equip, toss), built with the [item handover](features/storage/handing-items-over.md).
- **`build` fetching missing materials from the container index**: `fetch_from_storage` on `build`, see [Construction and building](features/world/construction-and-building.md).

## Found while building the plan, and built

Gaps that the phase pages and feature pages noted as "not built", and that later phases built.

- **Torches from storage for caves** (only carried and crafted torches were used): [Cave exploration](features/world/cave-exploration.md), [Phase 40](DEVELOPMENT-PLAN/phases/cave-torch-supply.md).
- **Fuel top-up at each look, walking away from the furnace, and fuel from storage for smelting:** [Gathering, crafting, smelting](features/gathering/gathering-crafting-smelting.md), [Phase 41](DEVELOPMENT-PLAN/phases/smelting-fuel-and-ready.md) (a `smelt_ready` signal instead of standing by; fuel is fetched at the start of a job).
- **Biome-guided search** (the bot had no biome port yet): [Biome tables](features/world/biome-tables.md), [Phase 38](DEVELOPMENT-PLAN/phases/biome-guided-search.md), with tables per Minecraft version and a 1.21.1 default.
- **A configurable Minecraft version** (`MC_VERSION`, 1.21.1 by default): [Phase 33](DEVELOPMENT-PLAN/phases/minecraft-version.md).

## Known issues from live sessions

Bugs and gaps found while playing, each written up with the cause and fix ideas under "Known issues" in the feature's own document. All of them were fixed in `fix/` phases of the development plan (each link ends the entry). Also picked from live sessions and built: breaking a block at exact coordinates ([Phase 23](DEVELOPMENT-PLAN/phases/break-block.md)), the crop field gate side and pumpkin fields ([Phase 25](DEVELOPMENT-PLAN/phases/crop-field-options.md)), filling buckets ([Phase 22](DEVELOPMENT-PLAN/phases/buckets.md)), and excavating upward and continuing an existing dig ([Phase 28](DEVELOPMENT-PLAN/phases/excavation-upward.md)).

- **`lure_animals` reports `penFull` when nothing could be led** and loses chickens that the bot outruns: [Animal farming, known issues](features/farming/animal-farming.md). Fixed in [Phase 24](DEVELOPMENT-PLAN/phases/farming-fixes.md).
- **Extra grass inside a freshly built pen** leaves cells that are not free, and the pen's own protected area stops the bot from clearing them: [Animal farming, known issues](features/farming/animal-farming.md). Fixed in [Phase 24](DEVELOPMENT-PLAN/phases/farming-fixes.md).
- **A crop field's water is at the field's edge and too little:** one source in the first row leaves far rows dry (a 7x7 field hydrated 5 of 7 rows), and a trench of water (or one block per 9x9 part, at its centre, on request) is the way it should work: [Crop farming, known issues](features/farming/crop-farming.md). Fixed in [Phase 24](DEVELOPMENT-PLAN/phases/farming-fixes.md).
- **The crop field gate is placed a quarter turn wrong** (perpendicular to the fence), and so is a pen's: [Crop farming, known issues](features/farming/crop-farming.md). Fixed in [Phase 24](DEVELOPMENT-PLAN/phases/farming-fixes.md).
- **The bot leaves gates and doors open behind it** (chickens walked out of a pen): the rule should be to close every gate or door after passing, on every path: [Opening ordinary doors, known issues](features/world/opening-ordinary-doors.md), with the pen side in [Animal farming, known issues](features/farming/animal-farming.md). Fixed in [Phase 26](DEVELOPMENT-PLAN/phases/closing-doors-behind.md).
- **Cave sealing put cobblestone inside a quarry's space**, and an excavation is never verified against its plan (no shape, seal, or extra-block check): [Excavation](features/world/excavation.md). Fixed in [Phase 27](DEVELOPMENT-PLAN/phases/excavation-reliability.md).
- **Several furnaces cannot be placed above the bot's feet level** (agent's diagnosis: no placing higher than its own feet): [Construction and building](features/world/construction-and-building.md). Fixed in [Phase 29](DEVELOPMENT-PLAN/phases/placement-fixes.md).
- **`place_sign` on a fence top fails to walk to the spot** (routes through an unrelated gate), and a torch on the fence gives no alternative: [Signs](features/world/signs.md). Fixed in [Phase 29](DEVELOPMENT-PLAN/phases/placement-fixes.md).
- **Gravel and sand stop a dig for good** (`falling_blocks`): [Excavation](features/world/excavation.md). Fixed in [Phase 27](DEVELOPMENT-PLAN/phases/excavation-reliability.md).
- **No way to dig a route to a specific ore** (`dig_to`): [Excavation](features/world/excavation.md). Fixed in [Phase 27](DEVELOPMENT-PLAN/phases/excavation-reliability.md).
