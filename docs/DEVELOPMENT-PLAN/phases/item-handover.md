# Phase 10: Item handover

_Estimate: ½ session._

**Depends on:** [3 Movement and perception](movement-perception.md), [9 Storage and containers](storage-containers.md).  
**Needed by:** [11 Drop recovery](drop-recovery.md).

Today there is no way to hand items over: the inventory port can drop items, but no tool exposes it, and nothing walks to a player, chooses what to give, or fetches it from storage. This phase adds that flow.

- Branch: `feature/item-handover`.
- **As built:** as planned. The request words are resolved by the server (`ItemResolver`), and the agent passes them as the player said them; `InventoryWriter` and `Gaze` are new ports. Not built: a retry that collects the items again when nobody picked them up (the result reports `unclaimed`; the drop-recovery feature takes them back), and telling the dimension of an unseen player apart from a far-away one.
- Reuses: `Navigator` (go to the player), `InventoryReader/Writer` (toss), and the storage feature (`FindItems`, `WithdrawItems`) as the source of items.
- `ItemResolver`: turns what you say ("iron", "some wood", "a stack of cobble", "food") into concrete item ids and counts, using minecraft-data names, plurals, and item groups. When the request is ambiguous ("wood" could be logs or planks) it returns candidates so that I ask you in chat. Counts like "a stack" or "all" are supported.
- `GiveItems` skill: input is the player (defaults to the owner), the items, and options (`fetch_from_storage`, default on; `keep_reserve`, default on; `mode`).
  1. Source: take from the inventory first, then from remembered chests (walks there, withdraws, returns), then report a typed `shortfall` with exactly what is missing so that the agent can offer to gather, craft, or hunt.
  2. Reserve: tools in use, armor, weapons, and food are not given unless named explicitly.
  3. Delivery: find the player (they may be far away; go to them, and report if they are in another dimension or unloaded), approach to about 2 to 3 blocks, face the player, and toss the items so they land at the player's feet, splitting into stacks with a short delay. Check that the drop spot is safe (not lava, water, or a ledge).
  4. Aftercare: step back so the bot does not re-collect its own drop right away, and verify the dropped item entities disappear (were picked up). What happens to items nobody picks up is decided by the drop-recovery feature (next phase): by default the bot collects them back after a timeout, unless the user said to leave them.
  5. `mode: chest`: for large amounts (many stacks), put the items in a chosen or nearby chest instead, and tell the player which one.
- Tools: `give_items`, `drop_items` (drop at the bot's own position, for example to get rid of junk; respects the reserve), and `resolve_item` (shows what a phrase maps to). The reverse direction, you giving items to the bot, needs no new tool: you drop them near it and `pickup_items` collects them.
- Safety: only the configured owner's requests count as instructions (`MC_OWNER`); never give items that are marked reserved or come from `protected` containers without confirmation; report exactly what was given.
- **Tests:**
  - unit: `ItemResolver` (names, plurals, groups, "a stack", "all", ambiguity candidates), `GiveItems` against fake `Navigator`/`InventoryWriter`/storage ports (source order inventory then chests, shortfall report, reserve rules, stack splitting, approach distance, unsafe drop spot, pickup verification and retry, player gone or in another dimension, abort)
  - integration: "give me 3 stacks of cobblestone" through the tool layer on a stateful fake world with items split between inventory and a chest; shortfall returns the missing counts; chest mode
  - e2e: a second Mineflayer bot acts as the player (its inventory is inspectable): `give_items` delivers the requested items; items fetched from a chest filled via RCON; shortfall case; reserved tools are not given; chest mode with many stacks
- **Exit criteria:** "give me 20 iron ingots" from chat makes the bot fetch them from the inventory or chests, walk to you, and drop them at your feet; you receive them, and if they are not enough the bot tells you exactly what is missing.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
