# Phase 12: Server commands and teleport

_Estimate: ½ session._

**Depends on:** [3 Movement and perception](movement-perception.md).  
**Needed by:** [20 Sleeping and respawn point](sleeping-respawn.md) (optional), [30 World discovery, including caves and canyons](world-discovery.md) (optional).

The bot can walk to you, but sometimes you want it next to you at once (it is far away, in a cave, or across water). When the server allows commands, it can teleport to you.

- Branch: `feature/server-commands`.
- **As built:** as planned, with these details. Availability comes from the `declare_commands` packet (the server sends the commands this player may use, and sends the list again when operator rights change), read by `commandNamesFrom` and kept on the bot by the factory; there is no probe command, because a command that is not on the list is exactly one the bot may not run. Replies are told apart by wording (`classifyReply`, pure): vanilla shows "Unknown or incomplete command" for a command the player may not use, so the list decides between `no_permission` and `unknown_command`. A server with command feedback off gives no reply (`sent`), and the skill then checks that the bot really moved. `TeleportSkill` uses `/tp @s <player>` or `/tp @s x y z`, and for a player target steps to a safe spot next to them (`SafeSpotFinder`, waiting for the chunks to arrive). There is no generic "run any command" tool, on purpose: every command that gets a tool decides for itself when it may be used.
- **What the server must allow:** on a LAN world "Allow cheats" must be on, **and the bot must be an operator** (`/op ClaudeBot`, typed by you as the host; cheats alone only make the host an operator). The bot cannot grant this to itself. Without it the tool answers `no_permission` with these instructions, and the agent offers walking (`goto`) instead.
- Port `ServerCommands`: `available(command)` (from the command tree the server sends at login, with a harmless probe as fallback) and `run(command)`, which sends the command, waits (bounded) for the server's reply in chat, and classifies it: `ok`, `no_permission`, `unknown_command`, `error` (with the server's text). Reusable later for the optional `/locate` accelerator in world discovery.
- Tools: `teleport_to_player` (player defaults to the owner) and `teleport_to_position`. **Only on your request**: the description tells the agent so, and no reflex or task ever teleports on its own. `get_status` reports whether commands and teleporting are available.
- Arrival: `/tp` puts the bot at the player's exact position, so it steps aside to a safe standing spot next to them (not in a wall, over lava, or in the air), and reports where it stands.
- **Tests:** unit: reply classification (success, no permission, unknown command, other errors, timeout), availability from a command tree, `TeleportSkill` (safe spot search, denied, timeout, aborted); integration: the tool through the MCP layer with a fake connection; e2e: the bot is opped through RCON and teleports to a player standing far away (arrives within 3 blocks, on solid ground); without op the answer is `no_permission` with the explanation.
- **Exit criteria:** "teleport to me" puts the bot next to you when commands are enabled, and explains exactly what to enable when they are not.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
