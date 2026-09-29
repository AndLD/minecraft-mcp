# Phase 29: Placement fixes: furnaces, and signs on fences

_Estimate: ½ session._

**Depends on:** [13 Construction engine and building](construction-building.md) (`Placer`, `StandingSpotChooser`, `Scaffolder`), [21 Signs](signs.md).  
**Optional:** [16 Site preparation: leveling, dug rooms, and opening doors](site-preparation.md) (`DoorOpeningNavigator`, for the sign route).  
**Needed by:** no later phase depends on it directly.

Placement problems found in live sessions. They are written up under "Known issues" in [Construction and building](../../features/world/construction-and-building.md) and [Signs](../../features/world/signs.md).

- Branch: `fix/placement-fixes`. Remove each known-issue bullet from the feature documents as it is fixed.
- **Several furnaces above the bot's feet level.** Asked for a row of four furnaces, the two at the level above ground failed: the server refused a furnace and even a torch there, through both `place_block` and `build`, while ground level worked. The agent's diagnosis (not yet confirmed) is that the bot cannot place a block on a cell higher than its own feet level. **First, reproduce** in a Docker e2e: a furnace and a torch at feet level, one above, and one two above, all in reach, and log what `placeBlock` is given (the reference block, the face, the bot's position and look direction). The fix then follows from the cause: the standing-spot search or a pillar-up step (`Scaffolder`) moves the bot up to the target's level, or the placement uses a side face of an existing block instead of the top of the block below. `smelt` places its own furnace, so it gains from the same fix.
- **`place_sign` on a fence top walks through an unrelated gate.** The bot was already next to the fence, `goto` to the spot succeeded at once, and `place_sign` still failed three times with `unreachable`, naming a gate of the chicken pen about 9 blocks away. The cause is not known; suspects are the standing spot lying on the far side of the fence line (so the route goes round through the pen gate) and `DoorOpeningNavigator` failing to open a gate the bot is not facing. Log the chosen spot and the route in the failure, add a unit test with a fence line and a gate, and fix what it shows.
- **A torch on the fence top blocks a sign and gives no way out.** The refusal (`blocked`) is right, since the bot never breaks a player's blocks unasked, but the reply only names the torch. Name the nearest free fence top or wall face in the message, and let the agent pass `replace_block: true` after the player agrees, so it can swap the torch for the sign.
- Tests:
  - unit: `PlaceSignSkill` and `StandingSpotChooser` with a fence line and a gate (the spot is on the reachable side, no route through an unrelated gate, the failure carries the spot and route), the `blocked` reply naming a free alternative, `replace_block` (refused without it, replaces the torch with it), and whatever the furnace reproduction shows (placing above feet level through the chosen fix)
  - integration: `build` with two rows of furnaces, and a sign on a fence top, on a stateful fake world
  - e2e: over a real Paper server, four furnaces in two rows are all placed; a sign is placed on a fence top beside a gate; with a torch on the fence the reply names a free spot and `replace_block` swaps it
- **Exit criteria:** "put four furnaces in two rows" places all four; "put a sign on top of that fence post" works beside a gate; when a torch is in the way the bot names a free spot and offers to replace it.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
