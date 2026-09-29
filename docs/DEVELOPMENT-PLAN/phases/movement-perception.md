# Phase 3: Movement and perception

_Estimate: 1 session._

**Depends on:** [2 Core skeleton and MCP shell](core-skeleton-mcp-shell.md).  
**Needed by:** [4 E2E test harness](e2e-harness.md), [6 Survival reflexes](survival-reflexes.md), [7 Gathering, crafting, smelting](gathering-crafting-smelting.md), [8 Hunting and food](hunting-food.md), [9 Storage and containers](storage-containers.md), [10 Item handover](item-handover.md), [12 Server commands and teleport](server-commands-teleport.md), [13 Construction engine and building](construction-building.md), [16 Site preparation: leveling, dug rooms, and opening doors](site-preparation.md), [20 Sleeping and respawn point](sleeping-respawn.md), [26 World discovery, including caves and canyons](world-discovery.md), [27 Leading a player](leading-a-player.md).

- Ports: `Navigator`, `BlockScanner`, `EntityScanner`. Adapters over pathfinder and Mineflayer.
- `Navigator` features: goto position/player/block, follow, stop, stuck detection, timeouts, safe movement profile (no digging through player builds, no lava).
- `TaskManager` (single active task, abort, progress, bounded wait) and `get_task_status` / `cancel_task`.
- Tools: `goto`, `follow_player`, `stop`, `look_around`, `find_blocks`, `get_nearby_entities`, `get_player_position`, `get_inventory`.
- Branch: `feature/movement-perception`.
- **Tests:**
  - unit: `TaskManager` (single active task, cancel, abort propagation, progress, timeout, bounded wait returning `running`), movement skills against a fake `Navigator` (success, unreachable, stuck, aborted), perception summaries against fake scanners
  - integration: chat "stop" → interceptor → `TaskManager` cancels a running fake-navigator task; `goto` over the wait budget returns `running`, then `get_task_status` reports completion (with a fake `Clock`)
- **Exit criteria:** "come here", "follow me", and "stop" work from in-game chat; a `goto` beyond the wait budget returns `running` and completes later.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
