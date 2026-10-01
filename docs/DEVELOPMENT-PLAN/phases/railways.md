# Phase 19: Railways

_Estimate: 2 sessions._

**Depends on:** [13 Construction engine and building](construction-building.md), [14 Excavation and mining](excavation-mining.md), [9 Storage and containers](storage-containers.md) (optional), [30 World discovery, including caves and canyons](world-discovery.md) (optional).  
**Needed by:** no later phase depends on it directly.

- Branch: `feature/railways`. Built on the construction engine, excavation (for underground lines), and lighting; materials come from the inventory or storage.
- **Route planning** (`RailRoutePlanner`): from a start to an end (coordinates, a player, or a landmark), as a chain of straight runs with 90° turns, staying within rail rules: slopes of one block up or down per rail, curves only with plain rails (powered rails cannot bend), no water or lava on the route. `layout`: `surface` (the line follows the terrain: gaps and dips are filled with support blocks, small rises are cut, water and ravines are bridged), `underground` (a tunnel dug by the excavation engine, lit, for a metro), or `auto` (surface where it is easy, underground where the terrain is not). A preview reports length, materials, and problems before anything is built.
- **Two variants:**
  - `economy`: plain rails, with a **powered rail every `spacing` blocks on level track (default 8; 7 to 10 allowed) and every 3 blocks on slopes**, each fed by its own redstone torch.
  - `rich`: powered rails all the way, for the best speed. Power passes from one powered rail to the next up to 8 rails away, so a redstone torch is needed about every 9 rails, not one per rail.
  - Both place a torch or redstone block for power next to each powered rail in a way that has to be verified in the game (the power layout is chosen by an e2e run: a minecart must actually accelerate along the test line).
- **Materials** (worked out by the planner and the recipe book): rails (6 iron ingots and a stick make 16), powered rails (6 gold ingots, a stick, and redstone make 6), redstone torches (redstone and a stick), minecarts (5 iron ingots), support blocks. A shortage is reported per item, with the offer to gather, smelt, or fetch it.
- **Trolley:** `place_minecart` puts a minecart on a rail (by default at the start of the line); riding it is up to you.
- **Verification:** after laying, the bot walks the line and checks every rail's presence, orientation, and powered state, and re-lays what is wrong.
- **As built** (`feature/railways`, details in [the railways feature file](../../features/world/railways.md)): the power layout was chosen by a real-server experiment, as the plan asked: a redstone torch **beside** a powered rail powers it, a block behind a powered first rail starts a resting cart, and plain rails alone stop a cart within about 10 blocks. The first rails of a line are therefore a powered **run of four** (a single powered rail every 8 left a cart that started from rest stranded 2 blocks in). `auto` picks surface or tunnel for the whole line, not per stretch. The engine gained `passable` and `clearedFirst` place steps and `standing: 'inside'` use for a tunnel.
- **Still to do in this phase (planned, not built in the first `feature/railways` pass):**
  - **Mixing surface and tunnel within one line.** `auto` now chooses for the whole line. The plan is per stretch: the level search already prices cutting, bridging, and following the ground, so a stretch is a tunnel where a hill or a ravine makes the surface cost more than digging through, and the ramps into and out of each tunnel are part of the profile. Each tunnel stretch is lit; the preview says which stretches are which.
  - **Landmarks as the ends** ("from the mine to the base"). Waits for `set_landmark`/`list_landmarks` in Phase 30; until then an end is coordinates or a player. `from` and `to` (and `to_player`) gain a landmark name, resolved the same way `build_farm` will resolve one.
  - **End stops.** A block or buffer at each end so a cart stops at the end of the line instead of running past it (a fence or a solid block beyond the last rail, and an unpowered rail before it so it brakes); optional per end.
- Tools: `plan_railway` (dry run), `build_railway`, `place_minecart`.
- **Tests:**
  - unit: route planning on synthetic terrain (slopes, turns, gaps, water, obstacles; `surface` versus `underground`), spacing rules for both variants (level and sloped runs), rail orientation at corners and slopes, material calculation, verification
  - integration: `build_railway` through the tool layer on a grid-based fake world, including a tunnel section
  - e2e: a surface line on flat ground and one that climbs a hill, both variants, verified through RCON block by block; a minecart placed at the start and pushed goes the whole way (speed checked); an underground line through a tunnel with torches; missing-materials report
- **Exit criteria:** "build a railway from here to the base, economy variant, and place a minecart" produces a working line (surface or underground) with the powered rails at the stated spacing, and the cart runs it.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
