# Phase 25: Crop field options: gate side and pumpkin fields

_Estimate: 1 session._  
**Status:** done on `feature/crop-field-options`. Decision taken at the start: only the build-time `gate_side` ships; moving the gate of an existing field is not built. Details in [Crop farming](../../features/farming/crop-farming.md).

**Depends on:** [18 Farming, crops, animals, and trees](farming.md) (`CropFieldProvider`, `fenceRingSteps`, `crop-table.ts`, `harvest_crops`, `inspect_farm`), [24 Farming fixes](farming-fixes.md) (the gate axis fix and the water layout).  
**Optional:** [22 Filling buckets with water and lava](buckets.md) (a field's water buckets could then be filled by the bot).  
**Needed by:** no later phase depends on it directly.

Two additions to `build_farm` and the crop tools, both asked for after live sessions with the first field. They belong in one branch because they touch the same files (`fence-ring.ts`, `crop-field.ts`, `crop-table.ts`).

- Branch: `feature/crop-field-options`.
- **Gate side.** Today the gate is always in the middle of the south side (`fenceRingSteps`), with no way to say otherwise. Add `gate_side` (`north`, `south`, `east`, `west`, default `south`, the current behaviour) to `build_farm` for a field, and store it in the registered farm so `inspect_farm` and `lure_animals` know where the entrance is. The fence ring is shared with `AnimalPenProvider`, so the option comes to pens with no extra work; say so in the tool description. Moving the gate of an **existing** field (take the gate out, close the gap with a fence post, place a gate on the new side) is a small plan of its own; decide at the start of the branch whether it ships here or only the build-time option does. **Already handled by [24 Farming fixes](farming-fixes.md):** the known bug that the gate is placed a quarter turn wrong is fixed there first, so a new side does not inherit it.
- **Pumpkin fields** (`crop: pumpkin`; melons work the same way, and would be one more table entry, but only pumpkins were asked for, so melons stay in [the farming extras backlog](../../backlog/farming-extras.md) unless that changes). A pumpkin is not a crop that is harvested in place like wheat: the planted seed grows a **stem** on farmland, and a ripe stem grows a `pumpkin` block on a free cell next to it. The block to harvest is the pumpkin; the stem must be left standing, and there is nothing to replant.
  - **Layout:** stems in every other row (or column) of tilled farmland, with the rows between them left free (grass or dirt, air above) for the pumpkins to grow into; water reaches the stems the same way as for other crops. The provider works out which cells hold stems and which stay free.
  - **`crop-table.ts`** gets a second kind of crop (`stem`), so `classifyCrop` and `cropFor` tell `PlantCropsSkill` to place `pumpkin_seeds` on tilled cells only in the stem rows, `HarvestCropsSkill` to break `pumpkin` blocks and never the stem (no replant, no age check on the block itself), and `InspectFarmSkill` to report stems growing, pumpkins ready, and free cells blocked. `tend_farm` needs no change beyond that.
  - **Seeds:** `pumpkin_seeds` come from crafting a pumpkin (one gives four); the bot keeps the same reserve rule as for other seeds. Where the first pumpkin comes from is the player's or the world's (patches near villages); the tool fails with `missing_materials` and says so.
- **Water layout** (a trench by default, spaced sources on request) is fixed in [24 Farming fixes](farming-fixes.md), in the same provider; this phase builds on it, and a pumpkin field uses the same water layouts.
- Tests:
  - unit: `fenceRingSteps` with each `gate_side` (gate at the middle of that side, oriented along the fence, posts elsewhere), `CropFieldProvider` for `pumpkin` (stem rows, free rows, no stem in a free row), `classifyCrop` for a stem crop, `PlantCropsSkill` and `HarvestCropsSkill` on a pumpkin field (seeds only in stem rows, breaks pumpkins, keeps the stem, no replant), `InspectFarmSkill` counts, the registry keeps `gateSide`
  - integration: `build_farm` for a wheat field on each side and for a pumpkin field on a stateful fake world; harvest a grown pumpkin and confirm the stem is still there
  - e2e: a field built with the gate on the east side over a real Paper server (gate present and in line with the fence); a pumpkin field built, one stem set to age 7 with a `pumpkin` beside it over RCON, harvested by `harvest_crops`, the stem still there
- **Exit criteria:** "make a wheat farm with the gate on the east side" builds it with the gate there, in line with the fence; "make a pumpkin field" builds it, plants stems, and "harvest the pumpkins" takes only the pumpkin blocks and leaves the stems.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
