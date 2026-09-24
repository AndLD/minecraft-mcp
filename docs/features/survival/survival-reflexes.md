# Survival reflexes

**Depends on:** [Threat policy](threat-policy.md), [Tasks](../core/tasks.md).  
**Used by:** [Hunting and food](../gathering/hunting-and-food.md), [Drop recovery](../storage/drop-recovery.md).

- `ReflexEngine` ticks every 250 ms while the bot is connected (started on `connected`, stopped on disconnect or shutdown) and needs no MCP client. Each tick it reads the vitals and nearby entities once, and lets the most important reflex that `wants` to act run. A running reflex is aborted when it stops wanting to act, when the bot leaves the world, or when a strictly more important one wants in.
- Priorities: `avoid_lava` 100, `drowning` 90, `threat_response` 80, `auto_eat` 20. A reflex with `preemptsTask` (everything except eating) first **suspends** the running task (`TaskManager.suspend()`, cancel reason `preempted`, the resume descriptor is remembered). When no reflex wants to act any more the engine **resumes** it through its resume descriptor, unless a reflex in that episode said `resumeTask: false` (fleeing: running back towards the danger would be wrong). Then the agent gets an event telling it to ask the player. The owner's `stop` or a new task discards the suspended one.
- While a reflex is acting, `TaskLauncher` refuses to start tasks (they would fight the reflex for the pathfinder); the error says which reflex is acting.
- Every reflex tells the agent what it did (`type: "reflex"` events in `wait_for_chat`, also recorded in the history log).
- **Reflex loops must never spin.** If a step can return without waiting (nothing to do, no path), await `context.sleep(ms)` (it resolves early on abort, including when the signal is already aborted).
- The threat policy is a data table in `src/reflexes/threat-policy.ts` (`MOB_RULES`); `assess()` is a pure function. Fighting is done in 1-second slices through `Combatant`, re-assessing between slices, so a fight turns into fleeing as soon as health drops to the threshold.
- Combat uses `setGoal(null)`-style stopping like movement (see the pathfinder gotcha in [Tasks](../core/tasks.md)). Attack timing per weapon lives in `src/bot/gear.ts`.
- **Deferred:** a fall-damage guard (water-bucket landing) and a night shelter. The pathfinder's default maximum drop already avoids large falls.

[Back to the features index](../FEATURES.md)
