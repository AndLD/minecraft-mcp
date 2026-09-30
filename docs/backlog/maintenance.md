# Maintenance

**Status:** ongoing.

- **`npm audit`** reports moderate issues in Mineflayer's authentication dependencies. They are upstream and unused in offline mode; revisit when Mineflayer updates them.
- **Node and testcontainers:** `testcontainers` is pinned to 11 because 12 needs Node 22.28 or newer. Revisit when the Node baseline moves.

[Back to the backlog](../BACKLOG.md)
