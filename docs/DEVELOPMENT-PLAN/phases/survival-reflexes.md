# Phase 6: Survival reflexes

_Estimate: 1 session._

- Reflex engine: priority arbitration, preemption/resume of the current task, event log.
- Reflexes: `AutoEat`, `ThreatResponse`, `AvoidLava`, `Drowning` (surface for air). `FallDamageGuard` and `NightShelter` are deferred: the pathfinder's default maximum drop already avoids large falls, and both need placing blocks or buckets, which fits better after the building work.
- Port: `Combatant` (attack an entity respecting the 1.21 attack cooldown, equip best weapon and armor, retreat). `ThreatResponse` and, later, hunting both use it.
- `ThreatResponse` follows the threat policy table in [the threat policy](../../features/survival/threat-policy.md): flee from skeletons and creepers, flee whenever health is at or below a threshold (default 8 of 20, env-configurable), fight every other hostile mob (equip best weapon and armor first), ignore endermen (never attack them). Fleeing means sprinting away until the threat is out of range and out of sight, preferring the direction of the owner or a known landmark.
- Event log integrated into `wait_for_chat` output.
- Branch: `feature/survival-reflexes`.
- **Tests:**
  - unit: each reflex against fake `VitalsReader`, `EntityScanner`, `Navigator`; `ThreatResponse` policy table exhaustively (skeleton/creeper flee, low health flee overrides fight, zombie/spider fight, enderman ignored, boss flee, threshold boundary); reflex engine arbitration by priority
  - integration: reflex preempts a running task and resumes it; events end up in the next `wait_for_chat`; reflexes work with no MCP client attached
  - e2e: zombie summoned nearby is fought and killed; creeper and skeleton summoned nearby are fled from; hunger set via RCON triggers eating; enderman is not attacked; low health triggers fleeing
- **Exit criteria:** with no MCP client attached, the bot eats when hungry, avoids lava, and reacts to a zombie; events appear in the next `wait_for_chat`.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
