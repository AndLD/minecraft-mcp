# Phase 2: Core skeleton and MCP shell

_Estimate: 1 session._

- `src/core`: port interfaces (`Connection`, `ChatPort`, `VitalsReader`, `Clock`, `Logger`) and shared types (`Position`, `Result`).
- `src/bot`: `MineflayerConnection` (connect/disconnect/reconnect events, error handling) and chat adapter.
- `src/chat`: `AgentInbox` (chat and events, `wait(timeout, signal)`, bounded buffer), `ChatRouter` (owner filtering, then fixed commands, then inbox), `StopCommand`.
- `src/bot`: `LanDiscovery` port and adapter (listens to the LAN broadcast on `224.0.2.60:4445`, returns the port and world name; used by `connect` when `MC_PORT` is not set).
- `src/mcp`: `ToolRegistry`, `ToolDefinition`, server bootstrap; tools `connect`, `disconnect`, `get_status`, `wait_for_chat`, `say`, `whisper`.
- Wiring in `src/app.ts` (`createApp(config, deps)`), so it can be built in tests with fakes; `src/index.ts` only reads env, calls `createApp`, and starts the stdio transport.
- Branch: `feature/core-mcp-shell`.
- **Tests:**
  - unit: `AgentInbox` (ordering, bounded buffer, owner filter, timeout, concurrent waiters), `ChatRouter`, `StopCommand`, `ToolRegistry`, each tool's input validation and output mapping, `MineflayerConnection` and chat adapter against a stub Mineflayer bot (event emitter)
  - integration: real MCP server and client connected through the SDK's in-memory transport, real `AgentInbox`/`ToolRegistry`, fake `Connection`/`ChatPort`: `connect` → incoming chat → `wait_for_chat` → `say`
- **Exit criteria:** register the server in Claude Code; Claude connects, says hello in game, and answers a chat message through the `wait_for_chat` loop.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
