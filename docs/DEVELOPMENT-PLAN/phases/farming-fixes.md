# Phase 24: Farming fixes

_Estimate: 1 session._

**Depends on:** [18 Farming, crops, animals, and trees](farming.md) (`CropFieldProvider`, `AnimalPenProvider`, `fenceRingSteps`, `LureAnimalsSkill`).  
**Optional:** [16 Site preparation: leveling, dug rooms, and opening doors](site-preparation.md) (`flatten_area`, for the pen interior).  
**Needed by:** [25 Crop field options: gate side and pumpkin fields](crop-field-options.md) (the gate fix must land before the gate-side option).

Four bugs found while playing with the first fields and pens. Each is written up with its cause and fix ideas under "Known issues" in [Crop farming](../../features/farming/crop-farming.md) and [Animal farming](../../features/farming/animal-farming.md); this phase fixes them together because three of them are in the shared fence ring and the two layout providers.

- Branch: `fix/farming-fixes`. Update the known-issues bullets in the feature documents in the same branch (remove each one as it is fixed, and describe the fix where the feature is described).
- **Gate axis.** `fenceRingSteps` gives the gate `alignAxis: 'x'` for the south side, so the bot stands in line along x and the gate lies across the fence. Derive the axis from the side the gate is on (a north or south gate needs `'z'`, an east or west gate needs `'x'`, the same rule the house door follows). The ring is shared, so this fixes pens too.
- **Water layout for fields.** The single source at the first row wastes half its reach outside the field and leaves far rows dry. A `water` parameter on `build_farm` for a field: `trench` (default: a line of water down the middle, so every row is within four blocks whatever the length) and `spots` (on request: one block per 9x9 part of the field, at the **centre** of that part). A lone water block is never placed on a side of the field, near the edge or the fence, unless it belongs to a trench. Revisit the width cap of 9, which was chosen for the single centre channel. The preview counts the water buckets needed (each has to be filled first: [22 Filling buckets with water and lava](buckets.md) makes that possible without the player).
- **`lure_animals` result and approach.** `penFull` is computed as `led < count`, so it is also true when nothing could be led at all. Report `penFull` only when the capacity check at the top fails, and report a shortfall through a separate field (or `abandoned`); fix the tool description to match. For the approach: pause between hops until the animal is within a few blocks again, re-read the animal's position and retry an `unreachable` approach, and for a far flock walk the bot next to it first, then lead in short hops.
- **Extra grass inside a fresh pen.** Clear the interior (or run `flatten_area` on the footprint) as part of the pen's steps, before the pen's own protected area is registered, so cells at fence level are free for animals and nothing needs removing by hand afterwards.
- Tests:
  - unit: `fenceRingSteps` on every side (the axis, gate at the middle of the side), `CropFieldProvider` for `trench` and `spots` (every plot within four blocks of water, no lone block at an edge, the count of buckets, sizes from 3 to the cap and lengths up to 32), `LureAnimalsSkill` (`penFull` only for the capacity check, a shortfall reported separately, pause between hops, retry after `unreachable`, far flock), `AnimalPenProvider` (interior cleared before protection)
  - integration: `build_farm` for a field with each `water` option and for a pen on uneven ground, on a stateful fake world; the gate is in line with the fence on both kinds
  - e2e: a field 7x7 and one long field built over a real Paper server, every farmland cell reads back as moist after a moment, and the gate's `facing` is in line with the fence; a pen built on bumpy ground has a clear interior
- **Exit criteria:** "make me a 7x7 wheat field" leaves every row watered and the gate in line with the fence; "make me a field with separate water blocks" places one at the centre of each 9x9 part and none on an edge; a pen built on uneven ground has nothing to clear by hand; `lure_animals` says plainly whether the pen was full or nothing could be led.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
