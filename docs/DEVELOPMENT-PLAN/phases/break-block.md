# Phase 26: Breaking a block at exact coordinates

_Estimate: ½ session._

**Depends on:** [3 Movement and perception](movement-perception.md), [7 Gathering, crafting, smelting](gathering-crafting-smelting.md) (the `Digger` port and protected areas).  
**Optional:** [13 Construction engine and building](construction-building.md) (the standing-spot search), [14 Excavation and mining](excavation-mining.md) (the hazard rule).  
**Needed by:** no later phase depends on it directly.

`collect_block` always takes the **nearest** block of a name, so it cannot remove one particular block. Found while placing a door in a player's build: to replace a single stair block, the player had to break it by hand, because the only tool that breaks blocks would have chosen whatever was nearest. A tool that acts on one named cell fits the "never grief" rule better than the tools that search: the player points at exactly what may go.

- Branch: `feature/break-block`. A `BreakBlockSkill` over the existing `Digger`, `Navigator`, `BlockScanner`, and `AreaGuard` ports (no new port, no engine); the tool file only translates input and output.
- **Tool `break_block`:** `x`, `y`, `z` (or `looking_at: true` to take the block the player's crosshair points at, through `LookTarget`), and `collect` (default true: pick up what drops). The bot walks to a standing spot within reach, breaks the block with the best tool it carries, and reads the cell back to confirm it is gone. One block per call: several blocks are several calls, or `excavate`.
- **Refusals, as values:** `protected_area` (through `AreaGuard`, never forced), `unbreakable` (bedrock, barrier), `no_suitable_tool` (names what to craft, like `collect_block`), `unreachable`, `not_loaded`, `already_air` (nothing to do, not a failure of the bot), and a hazard reason when lava or water sits behind the block (the same rule `excavate` uses: it breaks nothing that would let a liquid pour out). A block that holds items (a chest, a furnace, a barrel) is refused unless the player named it and `allow_containers` is set, since breaking it drops or loses the contents.
- **Facing the block above and below:** the standing-spot search decides where to stand (never on the cell being broken, never under a block that could fall on the bot: sand and gravel above are handled by the hazard rule).
- Tests:
  - unit: `BreakBlockSkill` against fakes (breaks and confirms, `looking_at`, every refusal above, collects the drop or not, abort mid-way, a spot out of reach walks first)
  - integration: `break_block` through the tool layer on a stateful fake world, including a protected area and a chest
  - e2e: a stair block, a stone block next to lava, a protected block, and bedrock set up over RCON, each answered as expected
- **Exit criteria:** "break the block at 12 70 -4" removes exactly that block and nothing else; the same call on a protected block or with lava behind it refuses and says why; "break the block I am looking at" works without coordinates.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
