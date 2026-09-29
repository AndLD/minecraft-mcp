# Phase 8: Hunting and food

_Estimate: 1 session._

**Depends on:** [3 Movement and perception](movement-perception.md), [6 Survival reflexes](survival-reflexes.md), [7 Gathering, crafting, smelting](gathering-crafting-smelting.md), [5 Persistent state](persistent-state.md) (optional).  
**Needed by:** [18 Farming, crops, animals, and trees](farming.md), [28 Autonomy, the bot's own will](autonomy.md).

The tools before this phase cannot hunt: perception can list entities and the reflexes only fight hostile mobs on their own, so there is no way to attack a specific passive animal, chase it, and collect the drops. This phase adds that flow.

- Branch: `feature/hunting`.
- **As built:** as planned, plus `AnimalScanner` (a new port over entity metadata) and `AnimalKiller` shared by `hunt_animals` and `attack_entity`. The goal is `item` + `count` or `species` + `count`. Not built: leash detection (Mineflayer does not expose the lead) and the "pause and wait for `resume_task`" flavor of the low-food decision: the `ask` policy emits a `needs_decision` event and the agent asks the player, and `set_food_policy` makes the decision standing. Cooked food is not deposited in chests yet (the storage feature comes later).
- Reuses: `Combatant` (survival reflexes phase), `Navigator` and `EntityScanner` (movement phase), `PickupItems` and `SmeltItems` (gathering phase).
- `AnimalCatalog` (data table): species → drops and behavior notes (cow: beef and leather, pig: porkchop, sheep: mutton and wool, chicken: chicken and feathers, rabbit: rabbit meat, rabbit hide, and others), plus protection rules that exclude:
  - tamed animals (owner set), animals with a custom name, leashed animals, saddled or ridden animals
  - villagers, iron golems, bees, and other neutral or non-livestock mobs
  - animals inside pens or fences (heuristic: enclosed area near player-built blocks) unless the user says so
  - the last breeding pair per species within the search area (`keep_breeders`, on by default); baby animals are skipped by default
- `HuntAnimals` skill: input is a species list or a target item and quantity (for example 20 raw beef or 10 leather), search radius, time limit, `keep_breeders`, and `cook`. Loop: find candidates → pick the nearest reachable one → approach (animals wander and flee, so re-path with a chase limit and give up on unreachable targets across water or cliffs) → equip the best weapon (sword, then axe, then bare hands) → attack in time with the 1.21 attack cooldown → pick up drops → repeat until the goal is met, no candidates are left, or the time limit is reached. Hostile mobs and low health are handled by the reflexes, which preempt and then resume the hunt.
- `cook: true`: after hunting, run the existing smelting skill on raw meat (furnace, smoker, or campfire when available; fuel handling included); with the storage feature present, cooked food can be deposited according to the storage rules (food category).
- **Low-food policy** (`LowFoodPolicy`, same pattern as the inventory-full policy): when food runs low and the inventory has nothing edible, the bot pauses or emits a `needs_decision` event; options are `ask` (default), `hunt_and_cook` (allowed by the user's instruction on the call or as a standing instruction), and `stop`. Works together with the `AutoEat` reflex, which keeps eating whatever food exists.
- Tools: `hunt_animals`, `list_huntable_animals` (what is around and what is protected), `attack_entity` (explicit single target, for requests like "kill that cow"; refuses protected animals unless overridden), `set_food_policy`.
- Safety: never harm pets or named animals; report species counts before and after; stop when the breeding-pair floor is reached and tell the user.
- **Tests:**
  - unit: `AnimalCatalog` (each protection rule, baby animals, breeding-pair floor), `HuntAnimals` against fake `EntityScanner`/`Navigator`/`Combatant` (nearest-first selection, chase give-up, attack cooldown timing with a fake clock, drop pickup, goal reached by item counts, no candidates, time limit, abort, hostile interruption), `LowFoodPolicy` (ask, hunt_and_cook, stop)
  - integration: hunt → smelt → (deposit) chain through the tool layer on a stateful fake world; a hostile appears mid-hunt, the reflex preempts, the hunt resumes; a low-food task pauses with `needs_decision` and continues after `resume_task`
  - e2e: cows, pigs, sheep and chickens summoned in an area via RCON, `hunt_animals` for N raw beef ends with the items in the inventory; a named cow and a tamed wolf are never attacked; the last breeding pair is preserved; `cook: true` yields cooked meat; with no food and no instruction the bot asks
- **Exit criteria:** "get me 10 steaks" from chat runs the full flow (hunt, drops, cook); protected animals stay unharmed; "if you run out of food, hunt" is remembered as a standing instruction and works.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
