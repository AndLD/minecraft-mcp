# Maintenance

**Status:** ongoing.

- **`npm audit`** reports moderate issues in Mineflayer's authentication dependencies. They are upstream and unused in offline mode; revisit when Mineflayer updates them.
- **Node and testcontainers:** `testcontainers` is pinned to 11 because 12 needs Node 22.28 or newer. Revisit when the Node baseline moves.
- **Biome tables for other Minecraft versions:** only 1.21.1 has a table; another version uses it (with one log line). Add a file per version when the bot is used on one (see [Biome tables](../../features/world/biome-tables.md)).

[Back to the backlog](../BACKLOG.md)
