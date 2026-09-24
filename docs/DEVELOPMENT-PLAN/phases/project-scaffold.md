# Phase 1: Project scaffold

_Estimate: ½ session._

**Depends on:** [0 Feasibility spike](feasibility-spike.md).  
**Needed by:** [2 Core skeleton and MCP shell](core-skeleton-mcp-shell.md).

- Branch: `feature/project-scaffold`.
- `package.json` (ESM, scripts), `tsconfig.json` (strict), eslint + prettier, Jest, `.gitignore`, `.env.example`.
- Jest setup: `jest.config.ts` for TypeScript + ESM (run through `node --experimental-vm-modules`), `.js`-extension module mapping, `@jest/globals` imports, separate unit and integration projects, coverage thresholds. Scripts: `test`, `test:unit`, `test:integration`, `test:coverage`.
- Test helpers: `test/fakes/` (fake `Clock`, `Random`, `Logger`) and a builder/factory convention for test data.
- `src/config/env.ts`: zod-validated env (`MC_HOST` default `localhost`, `MC_PORT`, `MC_VERSION`, `MC_USERNAME`, `MC_AUTH`, `MC_OWNER`, `MC_AUTO_CONNECT`, `DATA_DIR`, `LOG_LEVEL`).
- `Logger` port with a stderr implementation; lint rule against `console.log`.
- `CLAUDE.md` containing `@AGENTS.md` so Claude Code picks up the rules (already created).
- **Tests:**
  - unit: env schema (defaults, required `MC_PORT`, invalid values), stderr logger (never writes to stdout)
  - integration: `createApp()` with the config and fake ports builds without side effects
- **Exit criteria:** `typecheck`, `lint`, `test` pass on an empty-but-wired project; coverage gate is active.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
