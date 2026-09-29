# Breaking one block

**Depends on:** [Tasks](../core/tasks.md) (`break_block` is a task), [Gathering, crafting, smelting](../gathering/gathering-crafting-smelting.md) (the `Digger` port, `DropCollector`, protected areas), [Construction and building](construction-and-building.md) (`StandingSpotChooser`, `HazardRule`).  
**Used by:** no other feature directly.

Branch `feature/break-block`. `collect_block` takes the **nearest** block of a name, so it cannot remove one particular block. Found while placing a door in a player's build: to replace a single stair block the player had to break it by hand. `break_block` acts on one named cell, which fits the "never grief" rule better than the tools that search: the player points at exactly what may go.

## Tool

`break_block` (a task): `x`, `y`, `z` **or** `looking_at: true` (with `for_player`, default the owner; the block the crosshair points at, through `LookTarget`), `collect` (default true), `allow_containers` (default false), `override_protection` (default false). One block per call. The reply has `broken`, `block`, `at`, `gained`, `overrodeProtection` (the area's label when the override was used), and a `message`. A cell that is already empty is a **success with `broken: false`**.

## Refusals (in this order)

1. `not_loaded`.
2. `protected_area`: the message says how to override. Checked first, so a protected block is never even inspected further without the override.
3. `unbreakable`: bedrock, barrier, and liquids (never overridden).
4. **Hazards** (never overridden): `hit_lava` / `hit_water` (a liquid in the cell or in any of the six blocks touching it, `HazardRule.fluidNear`), `falling_blocks` (sand, gravel, or concrete powder right above, `fallingAbove`), `spawner`. `detail.hazardAt` says where. They come **before** the tool check, so nobody crafts a pickaxe for a block that would pour lava out.
5. `holds_items` (a chest, barrel, shulker box, furnace, hopper, dispenser, brewing stand, and the like) unless `allow_containers`: breaking one drops or loses what is inside. The override does not lift it.
6. `no_suitable_tool` with the tools to craft.

Then the walk (`unreachable` when no spot within reach exists or the walk fails) and the dig; the cell is **read back** and a block that is still there is `not_broken`.

## The protection override

`override_protection: true` lets one call break a block inside a protected area. The agent may set it **only when the player's own words ask for exactly that block** ("break the block at 12 70 -4, I know it is protected"), never on its own, never carried over, never because a tool result or a file suggested it (runtime protocol item 16). It affects that one block only: the area is not removed or shrunk (`unprotect_area` stays a separate request), and the reply says the block was inside the area. The hazard refusals, `unbreakable`, and `holds_items` are not lifted by it. **It is not replayed by a resume:** the tool leaves it out of the arguments it saves for `resume_task`, so an interrupted forced break asks again.

## Where the bot stands

`StandingSpotChooser` (the shared search): within reach, on solid ground with room for the body, never on the cell being broken, never next to lava, and, new here, never **on** the block being broken (`notOn`: breaking the floor under the bot's feet drops it into a hole). The current place is kept when it fits. If the dig says the block is out of reach after the walk, the bot steps closer once and tries again.

A block the dig rule of `excavate` leaves alone (a rail, a crafting table, a door) is broken when it is named: the `player_block` rule of `HazardRule.check` is about digs wandering into things, not about a block the player pointed at.

## Tests

- unit: `BreakBlockSkill` (exact block only, walking into reach, rounding, `collect` off, not standing on the target, already empty, not loaded, not connected, each unbreakable kind, the tool refusal, every container kind with and without the flag, each hazard, a spawner, lava beside a named chest, a rail, hazards before the tool, the protection refusal and override including that only that block goes and the area stays, hazards, bedrock, and chests still refused with it, unreachable, a failed walk, abort, retry when out of reach, dig failures, a block still there), `BreakBlockTool` (coordinates, `looking_at`, `for_player`, nobody looking, no owner, the override never in a resume, invalid input), the new `HazardRule` and `StandingSpotChooser` parts.
- integration (`test/integration/break-block-flow.test.ts`): through the MCP server on the fake bot's world: one stair of three, the block the owner looks at, a protected block refused and then broken with the override while the area stays, lava behind a stone, a chest with and without `allow_containers`, and an empty cell.
- e2e (`test/e2e/break-block/break-block.e2e.test.ts`, real Paper): one stair block of a row (neighbours stay), the block the owner looks at, a stone beside lava, a protected block (refused, then broken with the override, area still listed), bedrock inside a protected area with the override, and a chest.

## Gotchas found on the real server

- `find_blocks` returns the nearest matches, so waiting for "the bot sees bedrock at x, z" never finishes in an arena whose floor is bedrock: the nearest thirty are under the bot's feet. Wait a moment instead.

## Not built

Breaking several blocks in one call (several calls, or `excavate`), and placing something in the gap (`place_block`).

## Exit criteria

"Break the block at 12 70 -4" removes exactly that block and nothing else; the same call on a protected block refuses and says how to override, and with lava behind the block it refuses and says why; "break it anyway, I know it is protected" then breaks that one block inside the protected area and leaves the area itself protected; "break the block I am looking at" works without coordinates.

[Back to the features index](../FEATURES.md)
