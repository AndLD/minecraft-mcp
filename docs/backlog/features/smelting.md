# Smelting: gaps

**Status:** not planned.

Left out of [Gathering, crafting, smelting](../../features/gathering/gathering-crafting-smelting.md).

- **Crafting a blast furnace or a smoker on the way** (a blast furnace costs 5 iron ingots); they must stand nearby or be carried.
- **Nuggets from tools and armor** in a blast furnace: the smelting table does not have them.
- **Fuel from storage in the middle of a job:** it is taken at the start only; a job that runs out of fuel later ends `out_of_fuel` with the rest in the furnace.
- **Walking away with a limit:** the bot may leave a furnace while a job cooks, but nothing keeps it within a set distance; the `smelt_ready` signal only warns when the furnace is far away.

[Back to the backlog](../BACKLOG.md)
