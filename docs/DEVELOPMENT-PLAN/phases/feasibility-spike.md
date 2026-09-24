# Phase 0: Feasibility spike

_Estimate: ½ session._

**Depends on:** nothing (the starting point).  
**Needed by:** [1 Project scaffold](project-scaffold.md).

Branch: `feature/feasibility-spike`. Throwaway script (removed after the scaffold; it lives in git history), not part of the architecture and not covered by tests.

- Repository bootstrap first: initial commit with the docs on `main`, then create `development` from it.
- Bare Mineflayer bot joins the LAN world (1.21.1, offline) and echoes your chat back.
- Confirm: connection works, chat events arrive, bot can walk to you with `mineflayer-pathfinder`.
- Probe world-identity signals available to the client: hashed seed in the login packet, the server status/MOTD (world name), the LAN broadcast (which may also reveal the port automatically), world spawn point, dimension. Record which of them are stable across re-opening the same world.
- **Exit criteria:** the bot is visible in the world and replies to chat. If not, switch to the Paper fallback.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
