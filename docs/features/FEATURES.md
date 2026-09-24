# Features

How each implemented feature works: design decisions, gotchas found in real runs, tests, and exit criteria. The architecture, hard rules, ports, testing, and Git workflow stay in [AGENTS.md](../../AGENTS.md); what is planned and what is done is in the [development plan](../DEVELOPMENT-PLAN/DEVELOPMENT-PLAN.md).

**Working on a feature:** read its file first, change the code, and update the same file in the same branch. A new feature gets a new file here and a row below.

## Core

| Feature | What it covers |
|---|---|
| [Tasks](core/tasks.md) | The `TaskManager`, cancellation, `wait_seconds`, navigation supervision, pathfinder gotchas |
| [Persistent state](core/persistent-state.md) | Per-world profiles, world identification, state files, the task journal, history |
| [Chat and events](core/chat-and-events.md) | `ChatRouter`, `AgentInbox`, events returned with chat |

## Survival

| Feature | What it covers |
|---|---|
| [Threat policy](survival/threat-policy.md) | The mob-to-action table: flee, fight, ignore |
| [Survival reflexes](survival/survival-reflexes.md) | `ReflexEngine`, priorities, preempting and resuming tasks |

## Gathering and food

| Feature | What it covers |
|---|---|
| [Gathering, crafting, smelting](gathering/gathering-crafting-smelting.md) | `collect_block` (also structured pits and quarries), `craft`, `smelt`, protected areas |
| [Hunting and food](gathering/hunting-and-food.md) | `hunt_animals`, the animal catalog, the low-food policy |

## Storage and items

| Feature | What it covers |
|---|---|
| [Storage](storage/storage.md) | Container index, rules, policies, deposit and withdraw, full-inventory handling |
| [Handing items over](storage/handing-items-over.md) | `give_items`, item resolution, dropping at a player's feet |
| [Drop recovery](storage/drop-recovery.md) | Death drops, unclaimed drops, `recover_drops`, hazards |

## World changes

| Feature | What it covers |
|---|---|
| [Server commands and teleporting](world/server-commands-and-teleporting.md) | `ServerCommands`, `teleport_*`, permissions |
| [Construction and building](world/construction-and-building.md) | `WorkPlan`, `PlanExecutor`, blueprints, scaffolding |
| [Excavation](world/excavation.md) | Shapes, the hazard rule, torches, ore veins, ladders and stairs, cave sealing |
| [Site leveling](world/site-leveling.md) | `flatten_area`: cut, fill, and clear to a level |
| [Dug rooms](world/dug-rooms.md) | The `room` shape, wall targeting, entrance modes, doors |
| [Opening ordinary doors](world/opening-ordinary-doors.md) | `DoorOpeningNavigator`, gates and trapdoors |
| [Iron doors and switches](world/iron-doors-and-switches.md) | Buttons, levers, plates, `set_switch_policy`, `open_door` |
| [Railways](world/railways.md) | Route planning, power layout, verification, `place_minecart` |

## Farming

| Feature | What it covers |
|---|---|
| [Crop farming](farming/crop-farming.md) | Fields, `build_farm`, planting, harvesting, `tend_farm`, `FarmRegistry` |
| [Animal farming](farming/animal-farming.md) | Pens, luring, breeding, `HerdManager` |
| [Egg collection](farming/egg-collection.md) | `collect_eggs`, `set_egg_policy` |
| [Tree farming](farming/tree-farming.md) | Groves, `plant_trees`, `harvest_trees` |
| [Sapling collecting](farming/sapling-collecting.md) | `collect_saplings`, saplings on `collect_block` |
| [Discovering farms](farming/discovering-farms.md) | `discover_farm`: proposing farms found by scanning |
