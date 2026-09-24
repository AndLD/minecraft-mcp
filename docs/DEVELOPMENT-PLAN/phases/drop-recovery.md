# Phase 11: Drop recovery

_Estimate: 1 session._

The plan had no death handling at all, and nothing about items the bot has dropped that end up lying around. This phase makes recovering the bot's own drops automatic by default, and skippable whenever you ask.

- Branch: `feature/drop-recovery`.
- **As built:** as planned, with these differences. (1) There is no `DeathReflex` in the reflex engine: the engine polls every 250 ms and Mineflayer respawns the bot at once, so a death could fall between two ticks. Instead a `DeathWatcher` port reports the death from the bot's own events, and `DeathResponder` (plain code, like `LowFoodResponder`) reacts. The death is reported at the respawn: the server's death message has arrived by then, and the inventory before the death is taken from the last look before the fatal hit if the server had already emptied it. (2) keepInventory is not read from a game rule (the bot cannot): the inventory before the death is compared with the one two seconds after the respawn, and nothing lost means nothing to recover. (3) `AutoRecovery` starts the recovery task by itself (waiting for a running task or an acting reflex, for about three minutes) and tells the agent and the game chat how it went; `UnclaimedDropHandler` does the same for handover leftovers. (4) The unclaimed wait is the setting `UNCLAIMED_DROP_WAIT_SECONDS` (default 60), counted from the throw. (5) `list_death_records` lists both kinds of records. (6) After a restart nothing is recovered on its own: the session briefing lists the drops that can still be fetched (`pendingDrops`), and the agent asks the player. (7) A shield is put in the off hand together with armor and weapon (`equipBestGear`). (8) A bot that died while it was recovering does not go back on its own; it tells the agent instead.
- Two situations covered:
  1. **Death drop:** the bot died and its inventory lies at the death spot (items despawn after 5 minutes).
  2. **Unclaimed handover drop:** items dropped for a player that nobody picked up.
- `DropRecoveryPolicy`: `auto` (default) or `skip`. Set as a standing instruction (`set_drop_recovery_policy`, optionally per situation), or per call (`give_items(recollect_unclaimed: false)`), or told in chat at any moment ("forget it, do not go for it"), which calls `skip_drop_recovery`: any running recovery is cancelled, and the record is kept as `abandoned` with coordinates so you can fetch it yourself. Skipped or abandoned drops can be recovered later on request (`recover_drops`).
- Even in `auto`, the bot never wades into lava, void, or other hazards: when the spot looks unsafe it pauses in `waiting_for_input` with a `needs_decision` event and reasons, and I ask you.
- `DeathReflex` (a reflex in the existing reflex engine): detects death, respawns, and records a `DeathRecord` (position, dimension, time, cause, snapshot of the inventory before death, so it knows what was lost), saved through `StateStore` so it survives a relaunch. Emits a `bot_died` event and a chat message with the coordinates. If keepInventory is on, no recovery is needed and it is skipped.
- `RecoverDrops` skill:
  - hazard assessment of the death spot from a safe staging point (lava, void, deep water, fire, cacti, hostile mobs, wrong dimension), then approach with the safe movement profile
  - deadline: death time + 5 minutes minus a safety margin; if the ETA exceeds it, say so instead of trying
  - pick up all item entities around the spot (drops scatter), then re-equip armor, weapon, tools, and shield
  - report recovered versus lost items (from the pre-death snapshot)
  - max attempts (default 2) so it cannot loop into repeated deaths
- Unclaimed handover drops: after the pickup-verification timeout (default 60 s), with `auto` the bot collects the leftover items and tells the player; with `skip` (or `recollect_unclaimed: false`) it leaves them.
- `DropIgnoreList`: items the bot deliberately dropped (for example junk via `drop_items`) are never auto-recollected.
- Tools: `set_drop_recovery_policy`, `skip_drop_recovery`, `recover_drops`, `list_death_records`.
- **Tests:**
  - unit: `DeathReflex` (record contents, keepInventory case, persistence), `RecoverDrops` against fake scanners and navigator (hazard detected → asks, deadline math with a fake clock, max attempts, partial recovery report, re-equip), policy handling (auto, skip, cancel a running recovery, recover later), ignore list, unclaimed-drop logic
  - integration: bot dies → record persisted → app restarted → record still there and recovery proceeds or is offered; skipping mid-recovery cancels it and reports the coordinates; unclaimed handover drop is recollected in `auto` and left in `skip`
  - e2e: the bot holding items is killed through RCON, respawns, and recovers its items automatically; "skip" leaves them and reports the coordinates; a death spot surrounded by lava (built via RCON) leads to asking and not to a second death; an unclaimed handover drop is collected back after the timeout, and left when `recollect_unclaimed` is false
- **Exit criteria:** after the bot dies, it tells you where and recovers its stuff by itself; telling it to skip stops the attempt and gives you the coordinates; a dangerous spot is never entered without asking you.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
