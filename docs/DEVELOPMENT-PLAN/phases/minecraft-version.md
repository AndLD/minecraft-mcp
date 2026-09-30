# Phase 33: Configurable Minecraft version

_Estimate: ¼ session._  
**Status:** in review on `feature/configurable-minecraft-version`.

**Depends on:** [2 Core skeleton and MCP shell](core-skeleton-mcp-shell.md) (configuration), [4 E2E test harness](e2e-harness.md).  
**Needed by:** [42 Hardening and polish](hardening-polish.md) (a run against another version, if wanted).

The target Minecraft version is a setting, not a constant: `MC_VERSION`, **1.21.1 by default**.

- The bot reads it from the environment (`src/config/env.ts`) and connects as that version.
- The e2e harness follows it: `MC_VERSION` (when set) overrides `VERSION` in `docker/e2e-server.env`, and the app under test and the player bots use the version the server runs (kept in the server info file).
- README and AGENTS.md document it. The game data and skills are written and tested for 1.21.1, so another version may need fixes; that is not promised here.
- Tests: config unit tests (default and override) already existed; the e2e `leading-a-player` folder passes on the default.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
