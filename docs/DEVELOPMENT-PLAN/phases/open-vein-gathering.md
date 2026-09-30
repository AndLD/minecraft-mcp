# Phase 31: Open-vein gathering

_Estimate: ½ session._  
**Status:** done on `feature/open-vein-gathering`. Details in [Gathering, crafting, smelting](../../features/gathering/gathering-crafting-smelting.md) and [Cave exploration](../../features/world/cave-exploration.md).

**Depends on:** [13 Construction engine and building](construction-building.md), [14 Excavation and mining](excavation-mining.md) (`dig_to`), [30 World discovery, including caves and canyons](world-discovery.md) (`explore_caves`).  
**Needed by:** no later phase depends on it directly.

Asked for after the cave work: ore gathering was a pure x-ray search (nearest vein in the loaded area, buried or not), and a buried vein ended in `not_reachable_without_tunnelling`. A player looks for veins they can walk to first.

- `collect_block` on ores defaults to `search: open`: veins in view with a walkable way to them, else cave exploration until one is in view; never tunnels. `open_then_tunnel` digs a route to a buried vein when no open one exists; `nearest` is the old behaviour.
- Branch: `feature/open-vein-gathering`.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
