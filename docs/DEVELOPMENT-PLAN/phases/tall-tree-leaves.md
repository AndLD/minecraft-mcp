# Phase 39: Tall trees, cutting leaves

_Estimate: ¼ session._  
**Status:** not started.

**Depends on:** [34 Tall trees completion](tall-trees.md) (`harvest_trees` climbing a dirt tower, the `Scaffolder`), [13 Construction engine and building](construction-building.md).  
**Needed by:** [42 Hardening and polish](hardening-polish.md).

Phase 34 fells a tall tree from a dirt tower beside the trunk. The tower needs a free column, and a leafy canopy can fill every column next to the trunk, so such a tree is left as `left`. This phase cuts the leaves that are in the way, and only those.

- Branch: `feature/tall-tree-leaves`. Change `Scaffolder.plan` and `HarvestTreesSkill`, no new tool. `harvest_trees` keeps `reach_tall: pillar | skip`; leaf cutting is part of `pillar`.
- **Planning.** A column beside the trunk counts as free when everything above the ground in it is air **or a leaf block** of the tree (any `*_leaves`, not a player-built block: leaves the bot placed itself or that are `persistent` are recognised from the blockstate). `plan` prefers a column with fewer leaves, then the nearest, and reports how many leaves stand in the chosen column.
- **Cutting.** Before each block of the tower goes up, the leaf cells in the column above the bot's head (the cell it will jump into and the one above) are dug, so the pillar never presses into a leaf. Leaves break in one hit by hand; their drops (saplings, sticks, apples) are picked up with the rest and reported in `gained`. Only cells of the tower column are cut: the canopy stays for the tree to keep, and leaves that would need cutting more than a set number of cells (default 12) make that column unsuitable.
- **Not cut:** leaves of a different tree, leaves in a protected area, and any leaf block that a player placed (a hedge or roof made of leaves): the protected-area and player-built rules apply as they do for logs. Azalea and other non-tree leaves are left alone.
- **Result.** `harvest_trees` reports `leavesCut`. A tree with no column even after cutting is left as before (`left`), with the reason.
- **Docs.** The tree farming page (the tower and the leaves), AGENTS.md if the tool text changes.
- **Tests:**
  - unit: planning through leaves (a column of leaves is chosen over none only when the rest are blocked, fewest leaves first, the limit), cutting before each pillar (order, the drops picked up, protected leaves refused, a leaf that will not break ends that column), the counts
  - e2e (`test/e2e/tall-trees/`, extended): a 12-block oak with a real leaf canopy (leaves placed through RCON around the top) is felled to the last log, the tower is gone, and the trunk column is clear
- **Exit criteria:** "chop down that tree" on a full oak with a canopy that used to leave it standing removes every log, leaves the canopy to decay, and takes the tower down.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
