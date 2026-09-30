# Phase 32: Leading a player

_Estimate: ½ session._  
**Status:** done on `feature/leading-a-player` (the plan named it `feature/lead-player`). See [Leading a player](../../features/world/leading-a-player.md). Targets also include registered chests and farms and found biomes; the dimension check covers structures and biomes only, since landmarks and coordinates carry no dimension.

**Depends on:** [3 Movement and perception](movement-perception.md), [18 Farming, crops, animals, and trees](farming.md) (optional), [30 World discovery, including caves and canyons](world-discovery.md) (optional).  
**Needed by:** no later phase depends on it directly.

"Come to me and lead me to the village." A standalone feature, not part of discovery: the target can be a structure the bot found, a landmark (`home`), a registered container or farm, or plain coordinates, so it is useful with or without exploration. It builds on `Navigator`, the player lookup, `Gaze`, and chat.

- Branch: `feature/lead-player`. A `LeadPlayerSkill` (`lead_player`) in the movement skills; no engine and no new port beyond a way to face a player (the `Gaze` port already does).
- **Tool `lead_player`:** `target` (a landmark name, a known structure, or `x`, `y`, `z`), `lead_distance` (blocks, default 8, 5 to 16), `arrive_within` (default 8), and `for_player` (default the owner). The reply says what it is leading to and where.
- **The rule: the bot never gets farther from the player than `lead_distance`, and only advances when the player is close.** One loop, about twice a second:
  1. **Join.** If the bot is farther than `lead_distance` from the player, it first comes to the player (so "come to me and lead me" is a single request).
  2. **Lead.** While the player is within `resume_distance` (60% of `lead_distance`, 5 blocks by default), the bot walks the route to the target in short legs (a few blocks each, so it can stop at any moment), on the safe movement profile: it never digs or builds and avoids lava, and it prefers walkable ground, so a player can follow without special moves.
  3. **Wait.** When the distance reaches `lead_distance`, the bot stops and **turns to face the player**, and every 10 seconds or so says in chat that they should follow ("Follow me to the village"). It starts again only when the player has come back within `resume_distance`, so it does not jitter at the threshold.
  4. **The player goes elsewhere.** When the bot is waiting and the player walks away from it, the bot **goes towards the player** until the distance is under the limit again, and keeps calling them to follow. It never leaves them behind, and it does not wander ahead alone.
  5. **Arrive.** Within `arrive_within` blocks of the target it stops, says where they are ("We are at the village, x, y, z"), and the task ends with success.
- **Edge cases and safety.**
  - Player out of view or far away for about a minute: the bot stops and asks where they went (`player_lost`); after a long time of not following (about 10 minutes) the task ends (`player_not_following`).
  - Bot and target in different dimensions, or the player in another dimension: refused at the start with the reason.
  - The survival reflexes act as always and pause the task; after fleeing the task is not resumed on its own and the agent asks the player. The fixed `stop` command and `cancel_task` end it. A target that cannot be reached ends the task as `unreachable`.
  - Chat lines are throttled (one call per 10 seconds, one arrival line), so the bot never spams.
- **Tests:**
  - unit: the state machine over a fake clock, fake player positions, and a fake `Navigator` (join, lead, wait at the limit, resume at 60%, going elsewhere brings the bot back under the limit, call frequency, arrival, player lost, not following, dimension mismatch, abort, unreachable), and distance and threshold maths at the edges of the ranges
  - integration: `lead_player` through the tool layer on a stateful fake world with a scripted player who follows, lags, and walks off: the bot ends at the target, waits and calls when lagged, and follows a wandering player
  - e2e: on flat ground the owner bot follows the bot to a target 40 blocks away (both end near it, and the chat calls stayed within the limit); when the owner walks perpendicular the bot stays within `lead_distance` of the owner and does not reach the target; a `stop` ends the task
- **Exit criteria:** "come to me and lead me to the village" brings the bot to the player and then to the village, waiting and calling whenever the player falls behind, following the player if they wander, and saying when they have arrived.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
