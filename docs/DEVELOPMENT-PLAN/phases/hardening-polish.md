# Phase 48: Hardening and polish

_Estimate: 1 session._  
**Status:** built on `feature/hardening`, **the final gate is not green** and the 30-minute co-play session is still to be done by the player. See [Connection, reconnect, and hardening](../../features/core/connection-and-reconnect.md).

**Depends on:** every earlier phase (it hardens and verifies the whole system).  
**Needed by:** -.

- Reconnect logic and clean shutdown, timeouts on every I/O boundary, error messages written for the agent.
- Tool description review: each is short, states units and failure modes.
- Review of the shared safety rules (hazard envelope, light, drops) across excavation, site preparation, signs, railways, and cave exploration.
- Branch: `feature/hardening`.
- Tests: reconnect and shutdown behavior (unit and integration with fake `Connection`), timeouts on all I/O boundaries, coverage gap review.
  - e2e: server restart mid-session leads to reconnect; abrupt disconnect leaves no stuck task; a long-running scenario chaining gather → craft → build
- Write the "agent playbook" prompt based on real sessions; update README with tested flows.
- **Final gate (the only place the complete e2e suite is required):** run `test:e2e:all` (every phase's e2e tests together, including cross-phase scenarios) plus the full unit, integration, and coverage runs. Fix regressions found here on the `feature/hardening` branch or a dedicated `feature/*` fix branch.
- **What was done:** rejoining after a lost connection (`ReconnectSupervisor`), `wait_for_chat` that keeps waiting meanwhile, a test that audits every tool description and argument (four fixed), the timeout audit, the start prompt and AGENTS.md brought up to date, and the reconnect e2e. **Not done:** the agent playbook rewritten from real sessions, the written cross-review of the shared safety rules, and the 30-minute co-play session (needs the player's LAN world).
- **Final gate result (`test:e2e:all`, run twice):** 210 tests in 43 suites. First run: 6 suites failed (open-veins, door-opening, tree-grove, buckets, flatten-area, persistent-state); second run: 3 failed (buckets, flatten-area, and the new reconnect test, whose race was a test bug and is fixed). **Every one of them passes when its suite is run alone** (the six of the first run passed together in a rerun; buckets passed 4 of 4 alone), and a 15-suite subset failed in two other places (a different buckets test and an excavation room test). So the failures are timing-dependent and move between tests; they were not caused by one change. The server log of the long runs shows "moved too quickly" warnings (a lagging server), which fits RCON-driven worlds going out of step with the bot. Not fixed here: finding why long runs lag, and making the lava, door, and cave tests wait for the bot's own view as the farming tests do.
- **Exit criteria:** the full test run is green; 30-minute co-play session (gather → craft → build → explore) without restarts.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
