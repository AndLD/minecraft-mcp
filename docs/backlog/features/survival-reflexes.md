# Survival reflexes: gaps

**Status:** not planned.

- **Fall-damage guard.** Land in water with a bucket, or avoid the fall. It was meant to come with the cave exploration, but the cave feature only limits the planned drop to 3 blocks (the pathfinder's `maxDropDown`); nothing lands with a water bucket. It would reuse `FillBucketSkill` (see [Filling buckets](../../features/world/buckets.md)).
- **Night handling.** Two parts:
  - **A night shelter:** build or dig in when night falls far from a bed. Having a bed to go to is the sleeping feature (built).
  - **Long tasks stop for night and hostile mobs:** a structure search, a cave trip, or a fishing session does not stop for night or hostile mobs beyond what the reflexes do (see [World discovery](../../features/world/world-discovery.md) and [Fishing](../../features/gathering/fishing.md)). A shared "unsafe now" check that these tasks ask before each hop or cast would cover all three.
- **An e2e scenario for a reflex pausing and resuming a real task.** It is covered by integration tests only.

[Back to the backlog](../BACKLOG.md)
