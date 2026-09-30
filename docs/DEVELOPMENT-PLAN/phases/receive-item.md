# Phase 46: Take an item the player hands over

_Estimate: ½ session._  
**Status:** not started.

**Depends on:** [3 Movement and perception](movement-perception.md) (walking to a player, facing them, the player lookup), [7 Gathering, crafting, smelting](gathering-crafting-smelting.md) (`DropCollector`, `DroppedItemScanner`), [10 Item handover](item-handover.md) (`give_items`, `DropIgnoreList`, chat lines), [11 Drop recovery](drop-recovery.md) (unclaimed drops, so the two do not fight over the same item), [Tasks](../../features/core/tasks.md).  
**Needed by:** [47 Hardening and polish](hardening-polish.md).

The reverse of `give_items`. Today the player throws an item on the ground and asks the agent to pick it up (`pickup_items` with the item name walks onto it), and the digger and the combat code then use the best tool, weapon, or armor the bot carries, so a diamond pickaxe replaces a wooden one without any crafting chain. What is missing is one spoken step: "take this pickaxe" while the player holds it out or throws it. It comes from the backlog item of the same name.

- Branch: `feature/receive-item`. A `ReceiveItemSkill` (`receive_item`) in `src/skills/handover/`; no new port: it is built from the player lookup, `DroppedItemScanner`, `DropCollector`, `Gaze`, and the chat port.
- **Tool `receive_item`:** `item` (what to expect: an item name, a group such as `pickaxe`, or nothing for anything the player drops), `count` (default: whatever comes, up to a stack), `use_it` (default false: equip what was received at once through `equipBestGear`, and say so in chat), `wait_seconds` for the drop to come (default 30, up to 55), and `from_player` (default the owner). A task with progress and a result.
- **How it works.**
  1. **Go to the player.** If the bot is farther than 3 blocks it walks to about 1.5 blocks from the player and faces them (`Gaze`), so a throw lands in reach. It says in chat what it expects ("Ready: throw me the pickaxe"), once.
  2. **Watch for the drop.** It records what lies on the ground near the player when the task starts (a baseline) and then polls `DroppedItemScanner` (the injected `Scheduler`, every half second): only an item that **appears after the start**, near the player (within 6 blocks of where they stood at the throw), and that matches `item` counts. Old drops, the bot's own junk, and items that the bot itself threw earlier (the `DropIgnoreList` is **not** consulted here, so an item the player throws is never mistaken for one the bot dropped) are ignored by the baseline, not by a filter.
  3. **Pick it up.** The existing `DropCollector` walks onto it and confirms the inventory gained the item.
  4. **Confirm in chat** what it got ("Got the diamond pickaxe"), and with `use_it` say what it equipped.
- **Ends.** Success with what was received (`received`: item and count, `equipped`: what `equipBestGear` changed). `nothing_received` after the wait, saying so in chat once. `player_offline` and `player_lost` when the player is not there or out of sight for a while; `inventory_full` when there is no room (with the standing storage policy left alone: it asks in chat); `aborted` on `stop` or `cancel_task`.
- **Safety and manners.** It never takes anything from the player's hands or from a chest: only what is thrown to it. It does not run away with the item (no follow-up task). Only the owner's items by default; `from_player` names another player. A thrown item that the bot cannot carry stays on the ground and is reported, not left to despawn silently: the unclaimed-drop rule of the handover phase applies to it.
- **Docs.** The item handover page (the reverse direction), AGENTS.md (the tool table and a protocol item: when the player says "take this X" call `receive_item` and confirm what came), the backlog entry.
- **Tests:**
  - unit: the skill over a fake world of players and dropped items (walking up and facing, the baseline, a new matching item is taken, an old one and a wrong one are not, groups such as `pickaxe`, `count`, `nothing_received` after the wait, the player leaving, a full inventory, `use_it` equipping the best gear, cancel), the chat lines (once each), and the tool
  - integration: `receive_item` through the tool layer on a stateful fake world with a scripted player who throws an item: the bot ends carrying it, and `give_items` followed by `receive_item` round-trips an item
  - e2e (`test/e2e/item-handover/`, extended): the owner bot is given a diamond pickaxe through RCON and throws it (drop through RCON near the owner, since a real player bot cannot throw): the bot ends carrying it and, with `use_it`, holds it in hand
- **Exit criteria:** "take this pickaxe" (with the player throwing it) leaves the bot carrying it and saying so, an item that was on the ground before is left alone, and with nothing thrown the task ends `nothing_received` instead of waiting forever.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
