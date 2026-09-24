# Phase 17: Iron doors and switches

_Estimate: ¾ session._

An iron door cannot be opened by hand. It opens while something powers it: a button, a lever, or a pressure plate, usually beside the door. The bot cannot see the redstone behind them, so this phase recognises switches by where they are and checks by trying. It follows Phase 15's ordinary door opening.

- Branch: `feature/switches`. Reuses the door handling and `NavigationRunner` of Phase 16, and `LookTarget` for "the button I am looking at".
- **Tools:**
  - `press_switch`: press a button, toggle a lever, or step onto a plate at `at`, or the one the player looks at; the result says what happened to the door beside it, if any.
  - `open_door`: open a door, ordinary or iron, by position or the one the player looks at, optionally walking through (`walk_through`) and closing or restoring things behind (`restore`, default true). For an iron door it finds and tries the switches itself (below).
  - `find_switches`: read-only, lists the buttons, levers, and plates around a door or a position, with their kind and distance.
- **`SwitchFinder`.** Around a closed iron door, within about 4 blocks and on the side the bot is on, it lists buttons (wood and stone), levers, and pressure plates, nearest first, with the wall or floor each is on. It cannot know the wiring, so it is a **ranked guess that is verified**: press the best candidate, watch whether the door's `open` state changes, and if not, try the next one, at most 4 candidates and 2 rounds. A door that stays shut is reported as `door_did_not_open` with what was tried.
- **Timing.** A stone button holds the door open for about 1 second, a wooden one for 1.5 seconds, a lever until it is toggled back, and a plate while somebody stands on it. So `open_door` stands where both the switch and the door are within reach, presses, and **walks through at once** (`DoorPasser`); for a lever it goes through and then puts the lever back to how it was found (`restore`), so a house is not left open. A pressure plate in front of a door opens as the bot walks on it; the route does not avoid plates that lead to a door.
- **Safety.** Buttons and levers can also fire dispensers, pistons, TNT, or traps, and the bot cannot tell. So: **a `SwitchPolicy` standing instruction** (`ask`, the default, `auto`, `never`, mirrored as a standing instruction like the other policies): with `ask`, a walk that meets an iron door fails with `iron_door_blocked` and the switches found, and the agent asks the player before `open_door`; with `auto` the bot tries the switches beside the door it needs by itself; with `never` it does not. Only switches **within 4 blocks of the door** are ever tried on its own; anything else needs the player to point at it or give its position. It never presses switches in a protected area's machinery unless the player names them, and it stops after the limits above. A pressed switch that seems to have done something else (blocks changed around, an explosion) ends the attempt and is reported.
- **Navigation.** `goto` and the other walks report `iron_door_blocked` (with the candidates) instead of `needs_switch` when the policy is `ask`, and go through by themselves when it is `auto`.
- **Tests:**
  - unit: `SwitchFinder` (each kind, ranking, ignoring far or wrong-side switches), the press-verify-next loop and its limits, timing per button kind, the walk-through window, lever restore, `SwitchPolicy` (`ask`, `auto`, `never`), refusals, and `find_switches` changing nothing
  - integration: `open_door` and `goto` through an iron door on a stateful fake world with a button and a lever
  - e2e: an iron door with a stone button on the frame block beside it (over RCON): `open_door` with `walk_through` gets the bot in before the door closes; a lever door is left as it was found; a door with a decoy button that does nothing tries the next candidate; `find_switches` lists them; with policy `ask` `goto` reports `iron_door_blocked`
- **Exit criteria:** "get into the house" through an iron door with a button beside it asks (or, with the standing instruction `auto`, simply does it), presses the button, walks in, and leaves the house as it was (a lever put back); a door that does not react is reported with what was tried.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
