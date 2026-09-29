# Phase 7: Gathering, crafting, smelting

_Estimate: 1.5 sessions._

**Depends on:** [3 Movement and perception](movement-perception.md), [5 Persistent state](persistent-state.md).  
**Needed by:** [8 Hunting and food](hunting-food.md), [9 Storage and containers](storage-containers.md), [11 Drop recovery](drop-recovery.md), [13 Construction engine and building](construction-building.md), [14 Excavation and mining](excavation-mining.md) (optional), [15 Structured gathering: pits and quarries instead of scattered holes](structured-gathering.md), [18 Farming, crops, animals, and trees](farming.md), [28 Autonomy, the bot's own will](autonomy.md).

- Ports: `Digger`, `InventoryReader/Writer`, `Crafter`.
- Skills: `CollectBlocks` (find, path, dig, pick up drops, tool selection; own implementation, cancellable via `AbortSignal`, honors protected areas, returns typed failure reasons), `PickupItems`, `CraftItem` (recipe resolution with automatic sub-crafts, crafting table placement when needed), `SmeltItems` (furnace placement, fuel handling).
- Tools: `collect_block`, `pickup_items`, `craft`, `smelt`, `list_recipes`.
- Safety: refuse to dig protected areas; avoid digging straight down; when the inventory is full, stop with a typed, resumable `inventory_full` state (remembering where to continue); the policy for what to do next (ask, or offload and return) is implemented in the storage phase.
- Branch: `feature/gather-craft-smelt`.
- **As built:** also `ProtectedAreas` (boxes saved per world; tools `protect_area`, `unprotect_area`, `list_protected_areas`) as the `AreaGuard` behind "honors protected areas"; `WindowCrafter`, because Mineflayer's own `bot.craft` failed half way on a real 1.21.1 server (the e2e tests found it); block group names (`logs`, `ores`, `leaves`); `DroppedItemScanner` and `Placer` ports. There is no `InventoryWriter` yet: nothing in this phase needed it (the handover phase adds it). The failure result carries a machine-readable `detail` (mined, remaining) for the storage phase to resume from.
- **Tests:**
  - unit: `CollectBlocks` against fake `BlockScanner`/`Navigator`/`Digger` (found, none nearby, unreachable, no suitable tool, inventory full, protected area, abort mid-way, partial result), recipe resolution and sub-craft planning against fixed recipe data, smelting fuel logic
  - integration: `collect_block` → `craft` chain through the MCP tool layer with a stateful fake world (inventory changes), including cancellation
  - e2e: collect N logs from a prepared tree, craft planks/table/pickaxe, mine ore with the right tool and smelt it; cancellation mid-collect
- **Exit criteria:** from chat, "get 20 logs", "make a wooden pickaxe", "get 10 iron ore and smelt it" complete end to end.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
