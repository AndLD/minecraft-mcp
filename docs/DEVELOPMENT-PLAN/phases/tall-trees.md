# Phase 34: Tall trees completion

_Estimate: ½ session._  
**Status:** done on `feature/tall-trees`. See [Tree farming](../../features/farming/tree-farming.md). Built as `harvest_trees` with `reach_tall`; the tower is planned once for the lowest log out of reach and raised a block at a time after that. Cutting leaves that block every column beside the trunk is not built (such a tree is left as `left`); `collect_block` on logs is unchanged.

**Depends on:** [13 Construction engine and building](construction-building.md) (the `Scaffolder`), [18 Farming, crops, animals, and trees](farming.md) (`harvest_trees`), [7 Gathering, crafting, smelting](gathering-crafting-smelting.md) (`collect_block` for logs).  
**Needed by:** [46 Hardening and polish](hardening-polish.md).

Today the bot works from the ground and stops at what it can reach, so the top logs of a tall tree stay (`left` in the `harvest_trees` result) and the tree is neither counted as felled nor replanted. This phase finishes such trees. It comes from the backlog item "Reaching high logs".

- Branch: `feature/tall-trees`. No new tool: `harvest_trees` and `collect_block` (logs) gain the ability, and `harvest_trees` gets `reach_tall: 'pillar' | 'skip'` (default `pillar`).
- **How:** reuse the construction `Scaffolder` (jump, place a scaffold block underfoot, repeat; take the tower down from the top by breaking the block underfoot, never a fall of more than one block, always descending, also when cancelled or failed). For a tree, the tower stands beside the trunk, on a ground cell with a free column above, outside protected areas and not next to lava. The bot digs the logs within reach from each height, then descends and collects the drops.
- **Rules:** the scaffold block is dirt by default (it must be breakable with what the bot carries); the tower height is capped (the same `max_scaffold_height`, default 12); a tree that would need more is left as it is today and reported in `left`. Once the whole tree is down it counts as felled and is replanted like any other.
- **Safety:** never pillar in a protected area or beside a player build; abort on the usual reflexes (they pause the task and the descent still runs); a tower left by a crash is reported, not removed on its own.
- **Tests:**
  - unit: planning the tower beside a trunk (free column, height needed, capped height), the dig order from the top, the descent on failure and on abort, `reach_tall: skip` keeping today's behavior, and the counts (`left`, felled, replanted)
  - integration: `harvest_trees` on a stateful fake world with a tall tree: felled completely and replanted, tower gone, drops collected
  - e2e (`test/e2e/tall-trees/`): a 12-block oak built through RCON is felled to the last log, no scaffold block is left, and a sapling stands where it was
- **Exit criteria:** "chop down that tree" on a tall tree removes every log, leaves no tower behind, and replants; with `reach_tall: skip` the bot behaves as before.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
