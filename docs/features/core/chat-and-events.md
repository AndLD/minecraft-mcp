# Chat and events

**Depends on:** [Tasks](tasks.md).  
**Used by:** no other feature directly.

- `ChatRouter` receives every chat message: it drops messages from anyone but `MC_OWNER` (when set, case-insensitive), runs fixed commands in code (`stop`, as `ChatCommand` implementations) and turns them into an event, and gives everything else to the `AgentInbox`.
- `AgentInbox` buffers chat and events (bounded, oldest dropped, drops counted) and exposes `wait(timeoutMs, signal)`. Delivery is once-only.
- Connection changes, and later reflex and task events (`ate food`, `fled from creeper`, `task finished`), go into the same inbox and are returned together with chat by `wait_for_chat`, so the agent sees what happened while it was thinking.

[Back to the features index](../FEATURES.md)
