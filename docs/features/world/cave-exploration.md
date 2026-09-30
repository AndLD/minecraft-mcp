# Cave exploration

**Depends on:** [World discovery](world-discovery.md) (`WorldKnowledgeStore`, structure signatures), [Excavation](excavation.md) (`HazardRule`, torch rules via `SiteSafety`, `CraftingSupplies`), [Tasks](../core/tasks.md), [Survival reflexes](../survival/survival-reflexes.md) (stay active underground), [Construction and building](construction-and-building.md) (`Placer`).  
**Used by:** no other feature directly.

Branch `feature/cave-exploration`. "Explore this cave for diamonds": the bot goes in, lights the way, reports what it sees, and walks back out. Like all discovery, it moves as a regular player would: on foot, seeing only what is in view.

## Tool

`explore_caves` (a task). Options: `find` (block names such as `diamond_ore`, `ores`, or nothing for the valuable ones: diamond, gold, redstone, lapis, emerald, ancient debris; the deepslate kind of a named ore is included), `mine` (default false), `max_distance` (10-300 from the cave mouth, default 80), `max_minutes` (default 10), `min_light` (torch where block light is lower, default 5). Two options exist for other skills rather than for the agent: `stopOnFind` (end the trip as soon as a wanted vein with a walkable way to it is in view, `stopped: found`, staying there) and `returnOut: false`; open-vein gathering uses them (see [Gathering](../gathering/gathering-crafting-smelting.md)).

Result: `region` (`cave` or `ravine`), `entrance`, `stopped`, `finds` (new ones, also saved), `structures`, `mined`, `skipped` (veins left alone: `hazard`, `protected`, `no_tool`), `torchesPlaced`, `hops`, `farthest`, `returned`. `stopped` is `explored` (nothing new within `max_distance`), `time`, `low_health` (below 8), `hungry` (food below 4), `no_torches`, `warden`, or `stuck` (five trips in a row failed). Failures: `no_cave`, `bad_find`, `wrong_dimension` (Overworld only), `no_world_profile`, `aborted`. Finds are listed by `list_known_structures` (`finds`), and structures seen underground join the structure list.

## How it works

- **`CaveMap`** reads the loaded blocks as walkable space. A cell is standable with open feet and head, a solid floor that does not hurt (no magma, campfire, cactus), and **no lava within a block**; standing in water is refused. `reach` is a breadth-first walk over standable cells: step up 1 (with headroom), step down up to **3** (`MAX_DROP`), nearest first, bounded by a radius and a cell count. `roofed` finds natural rock above (a house or a tree does not count), `skyAbove` the opposite; `classify` calls a mostly sky-open cut at least 8 blocks deep a **ravine**, anything else a **cave**.
- **Getting in.** Under a roof already: start there. Otherwise `findMouth` walks the surroundings (40 blocks) for the nearest cell under natural rock and goes there first; `dropsAway` (ground falls 8 or more blocks within reach) accepts the top of a ravine; nothing at all is `no_cave`.
- **`ExploreCavesSkill`** loop: check the limits (time, health, hunger, a warden within 40 blocks), take the **nearest walkable cell not yet seen** (cells within 2 blocks of every stop count as seen) that is within `max_distance` of the mouth and away from any ancient city, walk there (`Navigator`), light it, look around. In a cave, only cells **under a roof** are candidates, so it does not wander over the surface; a ravine has no roof. A trip that fails marks the target seen and counts towards `stuck`. When it ends, or when a limit is hit, it walks back to where it started; if the direct way fails it goes back along its own breadcrumbs.
- **`LightManager`** puts a torch in the **right-hand** cell going in (then left, behind, underfoot) when `SiteSafety.needsTorch` says the spot is darker than `min_light` and no torch is within 6 blocks. With no torches it crafts 8 (coal or charcoal and sticks, through `CraftingSupplies`); with none left it stops with `no_torches` instead of going on in the dark.
- **`FindDetector`** reports the named blocks, **spawners**, and **geodes** (budding amethyst) within 24 blocks, only when the block has an **open face**: a player sees ore in a cave wall, not inside solid rock, so the bot does not look through stone either. Touching blocks are one vein. New finds are saved (`recordFind`: same name within 8 blocks is the same find). Mineshafts, dungeons, and strongholds go through the structure signatures, and so does the **ancient city** (reinforced deepslate or a sculk shrieker): it is reported and a 40-block zone around it is never entered; a warden ends the trip.
- **`VeinMiner`** (`mine: true`, only wanted ores): the whole vein (up to 24 blocks, including blocks joined to the ones seen) is dug block by block, unless any block is in a protected area (`protected`), has lava or water in it or beside it (`hazard`, the excavation hazard rule), or the bot has no tool that harvests it (`no_tool`); a block with gravel or sand above is skipped. Nothing is dug by default.
- **Falls.** The pathfinder's drop limit is set to **3** (its default is 4), for every trip the bot makes. The water-bucket landing guard from the plan is **not built**: the bot never plans a drop that would need it.

## Gotchas

- Bounding the walk is what keeps the search cheap: a breadth-first walk over open ground is thousands of cells. That is why a cave search only admits roofed cells and why the surface search for a mouth has its own, larger limit.
- Torches sit on the floor beside the way, not on the wall: it works with the existing `Placer` and needs no wall reference.
- No torches are fetched from storage; only carried ones and crafted ones are used.
- `list_known_structures` shows what was found; the position of a spawner is known but not the mob it spawns (the block data is not read).

## Tests

- **Unit:** `CaveMap` on carved worlds (standable, lava, drops of 3 and 4, headroom, roofs, sky, mouth, ravine), `LightManager` (side order, spacing, crafting, no torches, refusals), `resolveFind` and `FindDetector` (exposed versus buried, veins, spawners, geodes), `VeinMiner` (hazard, protected, no tool, gravel), the skill on `CaveWorld` (finds, torch spacing, no revisits, lava, distance, every stop reason, warden, ancient city, mining, mouth, ravine, abort, breadcrumbs), the tool, and the store.
- **E2E** (`test/e2e/world-discovery/caves.e2e.test.ts`): a stone hill with a tunnel, a diamond ore and a spawner in the wall and a lava pocket behind a wall: the bot enters from outside, places at least three torches, reports both, leaves the lava alone, and is back at its start; an iron vein is mined with a stone pickaxe; open ground gives `no_cave`.
