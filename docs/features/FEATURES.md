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
| [Fishing](gathering/fishing.md) | `fish`, the `fish_and_cook` food policy | Movement and perception, Gathering, crafting, smelting, Hunting and food |
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
| [Signs](world/signs.md) | `place_sign`, `edit_sign`, `remove_sign`, `read_signs`, sneaking while placing, `SignRegistry` | Storage, Construction and building, Persistent state, Gathering, crafting, smelting |
| [Breaking one block](world/breaking-one-block.md) | `break_block`: one block at exact coordinates, the refusals, the protection override | Tasks, Gathering, crafting, smelting, Construction and building |
| [Filling buckets](world/buckets.md) | `fill_bucket`: water and lava into empty buckets, source blocks only, the lava safety rules | Tasks, Construction and building, Gathering, crafting, smelting, Survival reflexes |
| [Railways](world/railways.md) | Route planning, power layout, verification, `place_minecart` | Construction and building, Excavation, Storage (optional) |
| [Cave exploration](world/cave-exploration.md) | `explore_caves`: `CaveMap`, torch lighting, finds, mining a vein, the ancient city rule | World discovery, Excavation, Construction and building, Survival reflexes |
| [Leading a player](world/leading-a-player.md) | `lead_player`: comes to the player, leads, waits and calls, follows a wanderer | Tasks, World discovery (optional), Storage (optional), Survival reflexes |
| [Biome tables](world/biome-tables.md) | Which biomes each structure generates in, per Minecraft version, with a 1.21.1 default; `BiomeGuidedExplorer` | World discovery, Configurable Minecraft version |
| [World discovery](world/world-discovery.md) | `explore_for_structure`, structure signatures, exploration strategies, landmarks, `WorldKnowledgeStore` | Tasks, Persistent state, Survival reflexes, Server commands and teleporting (optional) |

## Farming

| Feature | What it covers | Depends on |
|---|---|---|
| [Crop farming](farming/crop-farming.md) | Fields, `build_farm`, planting, harvesting, `tend_farm`, `FarmRegistry` | Construction and building, Persistent state, Gathering, crafting, smelting, Storage (optional) |
| [Animal farming](farming/animal-farming.md) | Pens, luring, breeding, `HerdManager` | Crop farming, Hunting and food, Construction and building, Opening ordinary doors (optional) |
| [Animal products](farming/animal-products.md) | `shear_sheep`, `milk_cows`, melons | Animal farming, Hunting and food, Gathering, crafting, smelting |
| [Egg collection](farming/egg-collection.md) | `collect_eggs`, `set_egg_policy` | Animal farming, Gathering, crafting, smelting, Storage (optional) |
| [Tree farming](farming/tree-farming.md) | Groves, `plant_trees`, `harvest_trees` (tall trees by tower) | Crop farming, Gathering, crafting, smelting, Construction and building (`Scaffolder`) |
| [Sapling collecting](farming/sapling-collecting.md) | `collect_saplings`, saplings on `collect_block` | Tree farming, Gathering, crafting, smelting |
| [Discovering farms](farming/discovering-farms.md) | `discover_farm`: proposing farms found by scanning | Crop farming, Animal farming |
