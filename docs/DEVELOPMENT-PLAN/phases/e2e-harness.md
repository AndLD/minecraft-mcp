# Phase 4: E2E test harness

_Estimate: 1 session._

**Depends on:** [2 Core skeleton and MCP shell](core-skeleton-mcp-shell.md), [3 Movement and perception](movement-perception.md).  
**Needed by:** no later phase depends on it directly.

- Branch: `feature/e2e-harness`.
- `docker/` with the server configuration (image `itzg/minecraft-server`, `TYPE=PAPER`, `VERSION=1.21.1`, `ONLINE_MODE=FALSE`, `EULA=TRUE`, RCON on, superflat world, `SPAWN_PROTECTION=0`, `DIFFICULTY` and `doMobSpawning` set per suite).
- Jest `e2e` project with a global setup/teardown that starts one server container for the whole run (`testcontainers`, random mapped ports, wait for the "Done" log line) and tears it down after; server and bot logs are attached to failures.
- `test/e2e/support/`: `E2EWorld` helper over RCON (`fill`, `setblock`, `give`, `clear`, `summon`, `kill`, `tp`, `time set`, `gamerule`, block/entity/inventory assertions), a helper that creates the real app via `createApp()` pointed at the container, and an MCP test client to call tools like the agent would.
- Per-test isolation: each test uses its own coordinates, resets the area, inventory, and mobs through RCON before running, and cleans up after.
- E2E tests are grouped by feature in `test/e2e/<feature>/` (for example `movement-perception/`, `survival-reflexes/`), never named with phase numbers. Scripts: `test:e2e -- <feature-dir>` runs only that feature's tests, and `test:e2e:all` runs the complete suite. Neither is part of `npm test`; there is no coverage gate; a clear failure message when Docker is unavailable.
- **Tests (the first e2e scenarios, covering Phases 2 and 3):**
  - the bot connects to the real server, appears in the player list, `say` shows up in the server log, and a chat message sent through RCON `tellraw`/a second bot reaches `wait_for_chat`
  - `goto` to coordinates and `follow_player` (player simulated by a second Mineflayer bot or RCON `tp`), and `stop` interrupts a running move
- **Exit criteria:** running only `test/e2e/movement-perception` starts the server, passes the smoke scenarios, and cleans up the container; the phase's tests are reliable across 5 consecutive runs.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
