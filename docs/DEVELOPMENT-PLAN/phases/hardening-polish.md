# Phase 28: Hardening and polish

_Estimate: 1 session._

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
- **Exit criteria:** the full test run is green; 30-minute co-play session (gather → craft → build → explore) without restarts.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
