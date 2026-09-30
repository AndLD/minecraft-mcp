# Several bots managed by one agent (horizontal scaling)

**Status:** not planned.

One agent running N bots in the same world. Left for later on purpose; the analysis so far:

- **Mineflayer is not the obstacle.** Several bots in one process work, and every `Mineflayer*` adapter only talks to a `BotHolder`, so skills are already independent of which bot is behind them.
- **What is single-bot by construction:** `createApp()` builds exactly one connection, `TaskManager`, `ReflexEngine`, inbox, death responder, and set of policies. The fix is a `BotRuntime` (the per-bot wiring) built N times, with `createApp()` becoming a factory plus shared services.
- **Tools** have no `bot` argument. One optional `bot` parameter, routed once in `ToolRegistry` (defaulting to the only bot), covers all tools.
- **Inbox and chat:** events need a bot name; `ChatRouter` needs addressing ("Bot2, get wood") or every bot obeys every message; `stop` needs a scope.
- **World state:** `WorldStateManager` closes the profile when one bot disconnects, so it needs reference counting. Death records, the task journal, and the food policy become per bot; containers, protected areas, storage rules, and landmarks stay per world.
- **The real design work is concurrency between bots:** two bots taking from the same chest, mining the same tree, or picking up each other's drops. That needs leases or reservations on containers and work areas.
- **Effort:** minimal (N independent bots addressed by name, shared chest memory) about one session; robust (leases, chat addressing, cross-bot handover, splitting one job among bots) two or three more.
- **No-code alternative today:** N MCP server processes, each with its own `MC_USERNAME` and its own `DATA_DIR` (two processes must not write the same profile files). No shared chest memory.
- **Best moment:** before the construction engine, whose `PlanExecutor` is where several bots pay off most (a plan can be partitioned among them). Adding it after the later phases means touching many more files.

[Back to the backlog](../BACKLOG.md)
