# Leading a player

**Depends on:** [Tasks](../core/tasks.md), [World discovery](world-discovery.md) (landmarks and found structures as targets, optional), [Storage](../storage/storage.md) and [Crop farming](../farming/crop-farming.md) (chest and farm labels as targets, optional), [Survival reflexes](../survival/survival-reflexes.md).  
**Used by:** no other feature directly.

Branch `feature/leading-a-player`. "Come to me and lead me to the village": the bot comes to the player, walks towards the destination with the player behind it, waits and calls when they fall behind, follows them if they wander, and says when they have arrived. It is a standalone feature: the target can be anything with a place.

## Tool

`lead_player` (a task): `target` (a landmark, a found structure or biome, a registered chest or farm label; "the" is ignored) or `x`, `y`, `z`; `lead_distance` (5-16, default 8); `arrive_within` (2-30, default 8); `for_player` (default the owner). Failures: `unknown target` (the message lists the known places and points at `explore_for_structure`), `wrong_dimension` (a structure or biome, and the bot is in the Nether or the End), `player_offline`, `player_lost`, `player_not_following`, `unreachable`, `aborted`. Names are looked up in this order: landmark, chest label or id, farm label or id, structure kind (nearest known one), biome.

## The rule

The bot never gets farther from the player than `lead_distance`, and only advances when the player is close. `LeadPlayerSkill` is one loop, twice a second (`TICK_MS`):

1. **Join.** Farther than the resume distance from the player at the start: come to them first (`goToPlayer`).
2. **Lead.** Walk in legs of 6 blocks along the line to the destination (the ground of each leg comes from `findSurface` when the column is loaded, else from the two ends' heights), so the bot can stop at any moment. The walk is the safe profile: no digging or building, lava avoided.
3. **Wait.** When the distance passes `lead_distance` the bot stops, **faces the player** (`Gaze`), and says "Follow me to the village" at most once every 10 seconds. It goes on only when the player is within `resumeDistance` = 60% of `lead_distance` (never under 3), so it does not jitter at the threshold; a player standing between the two keeps it waiting.
4. **The player goes elsewhere.** While waiting, a player who moves away (more than a block farther than half a second ago) or who is over twice the lead distance away is walked to (`goToPlayer` to the resume distance): the bot never wanders ahead alone and never leaves them behind.
5. **Arrive.** Within `arrive_within` of the destination it says "We are at the village: x, y, z" once and the task succeeds.

Limits: a player out of view for 60 seconds is `player_lost` (the bot asks where they went; it carries on if they come back before that); waiting 10 minutes with the player not coming is `player_not_following`; three legs in a row that fail are `unreachable`. Survival reflexes act as always; after fleeing the task is not resumed on its own, and the agent asks the player. The fixed `stop` command and `cancel_task` end it.

## Tests

- **Unit:** the state machine on `LeadWorld` (`test/fakes/lead-fakes.ts`: a bot and a scripted player on flat ground where time passes only when the bot walks or waits): join, short legs, lag, call throttling, hysteresis, a player who wanders or is far, `player_lost` and coming back, not following, offline, not connected, arrival, blocked legs, abort; the target resolver; the tool.
- **Integration** (`lead-player-flow.test.ts`): through the tool layer, a lagging player who wanders is brought to a village found earlier.
- **E2E** (`test/e2e/leading-a-player/`): a real Paper server. A real player bot cannot walk, so the test teleports the owner a step every half second (`drive`): a following owner is led 40 blocks and both end near the target with the separation never above the lead distance plus a leg; a standing owner makes the bot wait ("Waiting for ...") and a sideways-walking owner is followed; `stop` in chat ends the task.
