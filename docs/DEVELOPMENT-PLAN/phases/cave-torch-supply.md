# Phase 40: Torches from storage for caves

_Estimate: ¼ session._  
**Status:** done on `feature/cave-torch-supply`. See [Cave exploration](../../features/world/cave-exploration.md). Differences from this plan: a mid-run fetch happens only when the torches are used up (the reserve of 8 applies before going in, not during the trip); after a fetch the bot goes back to where the torches ran out, not to the entrance; when memory holds no torches the bot looks into the known unprotected containers once (a registered chest that was never opened has no remembered contents), which needed `skipProtected` on `scan_containers`' input.

**Depends on:** [30 World discovery, including caves and canyons](world-discovery.md) (`explore_caves`, `LightManager`), [9 Storage and containers](storage-containers.md) (`ContainerIndex`, `WithdrawItemsSkill`), [7 Gathering, crafting, smelting](gathering-crafting-smelting.md) (crafting torches).  
**Needed by:** [47 Hardening and polish](hardening-polish.md).

`explore_caves` lights the way with torches, and today it uses only the ones the bot carries or can craft from carried coal and sticks. With none it stops `no_torches` and asks the player to gather materials. When the player keeps torches in a chest, the bot should go and get them.

- Branch: `feature/cave-torch-supply`. A `TorchSupply` step used by `ExploreCavesSkill`, built from `ContainerIndex`, `WithdrawItemsSkill`, and the crafting supplies that exist; no new tool, and `explore_caves` gets `restock: boolean` (default true).
- **When.** Before the bot enters a cave, and again when the count of torches falls below a reserve (default 8) at a safe moment, it tops the inventory up to a target (default 64):
  1. use what is carried;
  2. otherwise take torches from a **registered, unprotected container** that holds them (the index says which; a scan refreshes it when the memory is old), nearest first;
  3. otherwise take coal or charcoal and sticks from storage and craft torches (4 torches from 1 coal and 1 stick).
- **Away from the cave.** The fetch happens **outside**: at the start before the entrance, and mid-run only after the bot has walked back out (it already does this on `low_health`, `hungry`, and `no_torches`). It then goes back in through the same entrance and carries on when the fetch worked, instead of ending the task; a fetch that finds nothing ends it as `no_torches`, saying what storage was checked.
- **Rules.** Protected containers are never opened; a container that the player marked as not to be emptied is respected; it takes only torches, coal, charcoal, and sticks; it never takes the last of a stack the storage rules reserve. The trips count against `max_minutes`.
- **Result.** `explore_caves` reports `restocked` (how many torches were taken and from where) and `stopped: 'no_torches'` only when storage had none either.
- **Docs.** The cave exploration page (remove "no torches are fetched from storage"), AGENTS.md item 18.
- **Tests:**
  - unit: `TorchSupply` over a fake storage world (carried enough, a chest with torches, coal and sticks to craft, nothing anywhere, a protected chest ignored, a stale index refreshed, nearest first), and the skill (restock before the entrance, walk out when low, restock, return and continue, give up when storage is empty)
  - e2e (`test/e2e/world-discovery/`, extended): a bot with no torches, a chest holding 64 of them, and a tunnel with a diamond ore: it fetches the torches, enters, lights the way, and reports `restocked`
- **Exit criteria:** with torches in a chest and none in the inventory, "explore this cave" fetches them, lights the cave, and comes back out; with none anywhere it says `no_torches` and what it checked.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
