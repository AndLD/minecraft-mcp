# Server commands and teleporting

**Depends on:** [Tasks](../core/tasks.md).  
**Used by:** no other feature directly.

- `ServerCommands` (`MineflayerServerCommands`) types a command as chat (`/tp ...`) and waits up to 1.5 s for the server's answer (`messagestr` lines that are not another player's `<name> text`). `available(command)` reads the command list the server sent at login (`declare_commands`, parsed by `commandNamesFrom`, stored by the factory as `bot.commandNames`): the server only lists what this player may use, so a missing `tp` means "not an operator, or cheats are off". The list is resent when `/op` or `/deop` happens, so `get_status` (`commands.canTeleport`: true, false, or null before the list arrives) follows it live.
- `TeleportSkill` (`teleport_to_player`, `teleport_to_position`): `no_permission` (with the exact instructions: open the world to LAN with "Allow cheats: ON", then the host types `/op <bot name>`; the bot cannot grant this itself) without sending anything when `tp` is not offered; `player_not_online`; `unknown_command`; `teleport_failed` with the server's words. It then checks that the bot really moved (a server may answer nothing). A player target puts the bot on the player's own block, so it steps to a safe spot beside them (no lava or water, solid ground, headroom).
- **Only on the player's request.** The tool descriptions say so, and no reflex, task, or responder ever calls them. Teleporting can also cross dimensions, and it skips everything between: use it because the player asked, not because walking is slow.
- Reply classification is by wording (`classifyReply`), because the text arrives without colours. Anything unrecognised counts as success and the skill verifies the effect, so a misjudged reply costs a clearer message, never a wrong action.

[Back to the features index](../FEATURES.md)
