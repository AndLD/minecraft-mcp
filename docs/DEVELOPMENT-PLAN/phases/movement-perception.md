# Phase 3: Movement and perception

_Estimate: 1 session._

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
