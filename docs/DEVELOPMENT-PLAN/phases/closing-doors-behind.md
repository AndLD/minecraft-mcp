# Phase 26: Closing gates and doors behind the bot

_Estimate: ½ session._  
**Status:** done on `feature/closing-doors-behind` (the branch is named after the feature, not `fix/close-doors-behind`). Decision: a door found open is not closed by the navigator; a pen's gate is shut by `PenGateGuard`. Details in [Opening ordinary doors](../../features/world/opening-ordinary-doors.md).

**Depends on:** [16 Site preparation: leveling, dug rooms, and opening doors](site-preparation.md) (`DoorOpeningNavigator`, `DoorAccess`).  
**Optional:** [18 Farming, crops, animals, and trees](farming.md) (pens are where an open gate costs the most).  
**Needed by:** no later phase depends on it directly.

During a live test the bot went into a chicken pen, worked inside it, and left with the gate open, and the chickens walked out. The rule is general, not about farms: **after passing through any gate, door, or trapdoor, the bot closes it, on every path.** The details of what the code does today, and the gaps that fit the symptom, are in [Opening ordinary doors, known issues](../../features/world/opening-ordinary-doors.md).

- Branch: `fix/close-doors-behind`. The change is in `DoorOpeningNavigator` and its callers; no new port.
- **Close on every path.** Today doors are closed only after a trip that succeeded and only the ones the wrapper opened itself. Close in a `finally`, so a trip that fails, is cancelled by `stop`, or is pre-empted by a reflex after the gate was opened still leaves it shut (the bot closes it before giving up if it is still within reach).
- **Remember what was opened.** Keep the list of doors the bot has opened in the session (per task, and a session-wide fallback), so the end of a task, or the next trip, closes any that are still open. When the bot ended too far from a gate to close it (`out_of_reach`), it walks back and closes it, rather than only logging.
- **Any gate or door it walks through, including one found open.** The rule as asked is "always close after passing through". A door standing open when the bot arrives is closed after the bot has passed too, unless the call says `close_doors: false`. To decide at the start of the branch: a player may hold a door open on purpose (for animals, for example), so a different default for a door found open, with the choice written in the tool description, is an option.
- **Pens.** A pen task (`lure_animals`, `breed_animals`, `hunt_animals` inside a pen, `collect_eggs`, `tend_farm`) checks that the pen's gate is shut before it ends and says so in the result if it could not shut it.
- **`follow_player`** gets the same closing where it passes doors (its trips have no stuck retry today; see the feature document).
- Not changed: iron doors (the switch policy decides those), and `close_doors: false` on `goto` still leaves a door open on request.
- Tests:
  - unit: `DoorOpeningNavigator` closes after a failed trip, after an abort, after a thrown error, and a door found open; walks back to close a gate it could not reach; the session list closes leftovers at the end of a task; `close_doors: false` still leaves it open; a failed close is reported, not thrown; each pen skill checks the gate at the end
  - integration: a pen visit (in, work, out) through the tool layer on a stateful fake world with a gate; the gate is shut at the end, also when the task is cancelled midway
  - e2e: over a real Paper server, the bot enters a fenced pen, is stopped in the middle, and the gate ends up closed; a normal visit leaves the gate closed
- **Exit criteria:** after any trip or task that went through a gate or door, including a cancelled one, every gate and door the bot passed is shut; a pen visit never leaves the herd able to walk out.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
