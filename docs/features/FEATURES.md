# Features

How each implemented feature works: design decisions, gotchas found in real runs, tests, and exit criteria. The architecture, hard rules, ports, testing, and Git workflow stay in [AGENTS.md](../../AGENTS.md); what is planned and what is done is in the [development plan](../DEVELOPMENT-PLAN/DEVELOPMENT-PLAN.md).

Each file also starts with **Depends on / Used by** lines; the last column below shows what a feature builds on. Phase-level ordering is in the [dependency table of the plan](../DEVELOPMENT-PLAN/DEVELOPMENT-PLAN.md#dependencies-between-phases).

**Working on a feature:** read its file first, change the code, and update the same file in the same branch. A new feature gets a new file here and a row below.

## Core

| Feature | What it covers | Depends on |
|---|---|---|
| [Tasks](core/tasks.md) | The `TaskManager`, cancellation, `wait_seconds`, navigation supervision, pathfinder gotchas | - |
| [Persistent state](core/persistent-state.md) | Per-world profiles, world identification, state files, the task journal, history | - |
| [Chat and events](core/chat-and-events.md) | `ChatRouter`, `AgentInbox`, events returned with chat | Tasks |

## Survival

| Feature | What it covers | Depends on |
|---|---|---|
| [Threat policy](survival/threat-policy.md) | The mob-to-action table: flee, fight, ignore | - |
| [Survival reflexes](survival/survival-reflexes.md) | `ReflexEngine`, priorities, preempting and resuming tasks | Threat policy, Tasks |
| [Sleeping and respawn point](survival/sleeping-and-respawn.md) | Beds, `sleep`, `set_respawn_point`, `place_bed`, the night policy, noticing a lost bed | Survival reflexes, Tasks, Persistent state, Drop recovery (optional), Server commands and teleporting (optional) |

## Gathering and food

| Feature | What it covers | Depends on |
|---|---|---|
| [Gathering, crafting, smelting](gathering/gathering-crafting-smelting.md) | `collect_block` (also structured pits and quarries), `craft`, `smelt`, protected areas | Tasks, Persistent state, Storage (optional), Excavation (optional) |
| [Hunting and food](gathering/hunting-and-food.md) | `hunt_animals`, the animal catalog, the low-food policy | Survival reflexes, Gathering, crafting, smelting, Persistent state, Storage (optional) |

## Storage and items

| Feature | What it covers | Depends on |
|---|---|---|
| [Storage](storage/storage.md) | Container index, rules, policies, deposit and withdraw, full-inventory handling | Persistent state, Tasks |
| [Handing items over](storage/handing-items-over.md) | `give_items`, item resolution, dropping at a player's feet | Storage, Drop recovery (optional) |
| [Drop recovery](storage/drop-recovery.md) | Death drops, unclaimed drops, `recover_drops`, hazards | Persistent state, Survival reflexes, Gathering, crafting, smelting, Handing items over (optional) |

## World changes

| Feature | What it covers | Depends on |
|---|---|---|
| [Server commands and teleporting](world/server-commands-and-teleporting.md) | `ServerCommands`, `teleport_*`, permissions | Tasks |
| [Construction and building](world/construction-and-building.md) | `WorkPlan`, `PlanExecutor`, blueprints, scaffolding | Persistent state, Gathering, crafting, smelting, Storage |
| [Excavation](world/excavation.md) | Shapes, the hazard rule, torches, ore veins, ladders and stairs, cave sealing | Construction and building, Gathering, crafting, smelting (optional), Storage (optional) |
| [Site leveling](world/site-leveling.md) | `flatten_area`: cut, fill, and clear to a level | Construction and building |
| [Dug rooms](world/dug-rooms.md) | The `room` shape, wall targeting, entrance modes, doors | Excavation, Construction and building |
| [Opening ordinary doors](world/opening-ordinary-doors.md) | `DoorOpeningNavigator`, gates and trapdoors | Tasks |
| [Iron doors and switches](world/iron-doors-and-switches.md) | Buttons, levers, plates, `set_switch_policy`, `open_door` | Opening ordinary doors, Persistent state |
| [Railways](world/railways.md) | Route planning, power layout, verification, `place_minecart` | Construction and building, Excavation, Storage (optional) |

## Farming

| Feature | What it covers | Depends on |
|---|---|---|
| [Crop farming](farming/crop-farming.md) | Fields, `build_farm`, planting, harvesting, `tend_farm`, `FarmRegistry` | Construction and building, Persistent state, Gathering, crafting, smelting, Storage (optional) |
| [Animal farming](farming/animal-farming.md) | Pens, luring, breeding, `HerdManager` | Crop farming, Hunting and food, Construction and building, Opening ordinary doors (optional) |
| [Egg collection](farming/egg-collection.md) | `collect_eggs`, `set_egg_policy` | Animal farming, Gathering, crafting, smelting, Storage (optional) |
| [Tree farming](farming/tree-farming.md) | Groves, `plant_trees`, `harvest_trees` | Crop farming, Gathering, crafting, smelting |
| [Sapling collecting](farming/sapling-collecting.md) | `collect_saplings`, saplings on `collect_block` | Tree farming, Gathering, crafting, smelting |
| [Discovering farms](farming/discovering-farms.md) | `discover_farm`: proposing farms found by scanning | Crop farming, Animal farming |
