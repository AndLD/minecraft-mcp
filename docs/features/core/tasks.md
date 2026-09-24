# Tasks

**Depends on:** nothing (a base feature).  
**Used by:** [Chat and events](chat-and-events.md), [Survival reflexes](../survival/survival-reflexes.md), [Gathering, crafting, smelting](../gathering/gathering-crafting-smelting.md), [Storage](../storage/storage.md), [Server commands and teleporting](../world/server-commands-and-teleporting.md), [Opening ordinary doors](../world/opening-ordinary-doors.md).

- The `TaskManager` (also the default `StopHandler`) runs **one** active task at a time; a task waiting for input still holds the slot. Starting a new one requires cancelling or queueing the current one explicitly.
- Every task gets an `AbortSignal`; skills must check it between steps and inside loops.
- Task-running tools take `wait_seconds` (0 to 55; `goto` defaults to 30, `follow_player` to 2) and `replace` (cancel the running task first; without it a running task blocks new ones). When the wait runs out they return `{ status: "running", taskId, progress }`; the agent polls with `get_task_status` and can `cancel_task` or `stop`. Failures carry a machine-friendly `reason` (`unreachable`, `stuck`, `timeout`, `target_not_found`, `block_not_found`, ...). Tools launch tasks through the shared `TaskLauncher`.
- Movement is supervised by `NavigationRunner`: it stops the bot on abort, gives up on timeout (30 s plus 1.5 s per block), on being stuck (no 0.75-block progress for 8 s), or when a followed player is out of view for 10 s. The safe movement profile never digs or builds and avoids lava. `DoorOpeningNavigator` wraps whatever `Navigator` this produces (see [Opening ordinary doors](../world/opening-ordinary-doors.md)), so a closed door in the way is opened, walked through, and (by default) closed again, transparently to `NavigationRunner` and everything above it.
- Mineflayer gotcha: halt the pathfinder with `setGoal(null)`, never with its `stop()`. `stop()` only sets a flag that is honored at the next path node, and when the bot is idle the flag lingers and makes the next `goto` fail at once with "Path was stopped" (found in a live test; regression tests cover it).
- Reflexes can pause/preempt a task and resume it after; they emit events into the event log.

[Back to the features index](../FEATURES.md)
