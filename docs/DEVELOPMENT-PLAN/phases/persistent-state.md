# Phase 5: Persistent state

_Estimate: 1.5 sessions._

**Depends on:** [2 Core skeleton and MCP shell](core-skeleton-mcp-shell.md).  
**Needed by:** [7 Gathering, crafting, smelting](gathering-crafting-smelting.md), [8 Hunting and food](hunting-food.md) (optional), [9 Storage and containers](storage-containers.md), [11 Drop recovery](drop-recovery.md), [13 Construction engine and building](construction-building.md) (optional), [30 World discovery, including caves and canyons](world-discovery.md).

- Branch: `feature/persistent-state`.
- Ports: `StateStore` (load/save versioned JSON documents by key), `WorldIdentifier` (produces a world fingerprint from the connection). Implementation: `FileStateStore` with atomic write (temp file + rename), a backup copy, schema versions with migrations, debounced writes, flush on shutdown, and a fallback to empty state with a warning when a file is corrupt.
- **World profiles.** Data lives under `DATA_DIR/<profile>/`. On connect, `WorldIdentifier` builds a fingerprint from whatever signals the spike showed to be stable (candidates: hashed seed, world name from the MOTD, world spawn point, dimension). Resolution order:
  1. fingerprint matches a stored profile → use it automatically
  2. no match and no stored profiles → create a profile named after the detected world name (or a generated one) and store the fingerprint
  3. ambiguous or no usable signals → fall back to the name given by the user (`WORLD_PROFILE` or `connect(profile)`); if none was given, the session briefing asks the agent to ask you
  Tools: `list_worlds`, `set_world_profile`.
- **Task journal** (`TaskJournal`, built on `TaskManager` events): records each task's tool, parameters, status, and progress checkpoints. After a relaunch, unfinished tasks appear as `interrupted` with their progress. Tool `resume_interrupted_task` (and `discard_interrupted_task`); nothing resumes automatically because the world may have changed.
- **Standing instructions:** policies and settings set through tools (threat overrides, storage policy later) are stored and restored per profile.
- **Instruction and event log:** append-only JSON lines of your chat instructions, tool calls with results, and reflex events; bounded and rotated. Tool: `get_recent_history`.
- **Agent notes:** `remember`, `recall`, `forget`: free-text notes with optional tags (for example "house plan", "player prefers oak", "base is at ..."), independent of the Claude session.
- **Session briefing:** `connect` (and `get_session_briefing`) returns the resolved world profile, time since the last session, interrupted tasks, standing instructions, key landmarks, recent history, and notes. The runtime protocol requires the agent to read it first and tell you in chat what it found.
- Later features (reflexes' overrides, storage, discovery) build on `StateStore`; the `WorldKnowledgeStore` is a thin domain layer over it.
- **Tests:**
  - unit: `FileStateStore` (atomic write, backup recovery, corrupt file, migration, debounce and flush), world profile resolution (match, new world, ambiguous, no signals, name fallback), `TaskJournal` (checkpoints, interrupted detection), history rotation, notes CRUD, briefing composition, all with a fake `Clock` and an in-memory or temp-dir store
  - integration: run a task, "kill" the app, create a new app instance on the same temp directory: the task is listed as `interrupted`, standing instructions and notes are restored, the briefing is correct; two profiles stay isolated; a different fingerprint does not load the old profile
  - e2e: connect to the Docker server, save a landmark and a note, restart the app, reconnect to the same world (fingerprint match, no name given) and get the same briefing; a re-created world with a different seed gets a new profile
- **Exit criteria:** after relaunching the MCP server and reconnecting to the same LAN world, the briefing shows the previous session; an unfinished task is offered for resume, and a different world does not see the old world's data.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
