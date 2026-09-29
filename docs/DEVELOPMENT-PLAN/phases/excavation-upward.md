# Phase 28: Excavating upward and continuing an existing dig

_Estimate: 1 session._  
**Status:** done on `feature/excavation-upward`. Decision: continuing uses a saved record of the bot's own digs, not a footprint read out of the blocks (a hand-dug hole is not recognised: give its origin, or dig it again over the same origin). Details in [Excavation](../../features/world/excavation.md).

**Depends on:** [14 Excavation and mining](excavation-mining.md), [15 Structured gathering: pits and quarries instead of scattered holes](structured-gathering.md).  
**Optional:** [27 Excavation reliability](excavation-reliability.md) (the verification pass).  
**Needed by:** no later phase depends on it directly.

Every excavation shape is dug from the top down, starting at the origin. That fails in a case found in a live session: the player pointed at a short quarry that already existed and asked the bot to make it deeper, with its stair walls continued. The bot dug only the hole (no walls), and when asked again for the walls it got stuck, because the stair steps are planned from the top downward and it was standing at the bottom of the quarry. Two things are missing: **continuing** a dig that already exists, and digging **bottom to top** on request.

- Branch: `feature/excavation-upward`.
- **Continue an existing excavation.** `excavate` for a `quarry` (and `pit`, `shaft`, `staircase_down`) takes `continue_existing: true`: the footprint, direction, and stair ring of what is already there are found (from the record `list_excavations` keeps when the bot dug it, or by reading the blocks when the player dug it by hand or the record is gone), and the new plan **extends** them to the target level: the hole goes deeper and the stair walls carry on from the last existing step, at the same width and height. The reply says what it found ("a 5x5 quarry, 6 deep, stairs on the outer ring, last step at y 58") and what it will add, and `preview_excavation` shows the same. If the existing shape cannot be recognised with enough confidence, it refuses and asks rather than guessing a footprint.
- **Reverse order on request.** A plan option (`order: 'bottom_up'`, default `top_down`) plans the walls, stairs, or shaft **from the bottom upward**, so a bot at the bottom of a quarry can cut its own way out. The chain rule stays the same, mirrored: each cell needs the one below it (or beside it on the stair), and the bot never digs the cell it stands on unless it is a designed step. Standing spots are chosen for the reversed order, so the bot never has to be above what it digs.
  - Hazards do not change: the hazard rule stops one cell short of lava and water; sand and gravel **above** the bot are the dangerous case for an upward dig, and stay stopped by the hazard rule (see the [known issue on falling blocks](../../features/world/excavation.md)) rather than dug under; cave sealing applies the same way. Upward stairs need the bot to stand safely at every step, so a step is only dug once the cell to stand on next is known to be solid.
- **Pairs with** the verification pass in [27 Excavation reliability](excavation-reliability.md): a continued dig is the case that most needs a check that the result matches the plan, so if that phase is done first, this one uses it.
- Tests:
  - unit: recognising an existing quarry from a block grid (footprint, depth, stair ring, width and height of the steps) and from a saved record; the extended plan (deeper hole, stairs continuing, no duplicated steps); the `bottom_up` chain and standing spots; a refusal for a shape that cannot be recognised
  - integration: `excavate` with `continue_existing` through the tool layer on a fake world after a first shallow dig, and with `order: bottom_up` from the bottom of a finished quarry
  - e2e: a short quarry with stair walls dug over a real Paper server, then deepened with `continue_existing`; every new step is present and joins the old ones; the bot walks out again. A stair-less deep hole given walls with `bottom_up` from the bottom
- **Exit criteria:** "make this quarry deeper" (pointing at a shallow quarry) extends the hole and the stair walls in one call, with the new steps joined to the old; "add the stair walls" from the bottom of a quarry cuts them upward without getting stuck.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
