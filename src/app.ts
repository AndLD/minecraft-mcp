import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { AgentInbox } from './chat/agent-inbox.js'
import { ChatRouter } from './chat/chat-router.js'
import { StopCommand } from './chat/stop-command.js'
import type { BotFactory } from './bot/bot-like.types.js'
import { MineflayerCombatDriver } from './bot/combat-driver.js'
import { MeleeCombatant } from './bot/melee-combatant.js'
import { MineflayerAnimalScanner } from './bot/mineflayer-animal-scanner.js'
import { MineflayerBlockScanner } from './bot/mineflayer-block-scanner.js'
import { MineflayerChat } from './bot/mineflayer-chat.js'
import { MineflayerConnection } from './bot/mineflayer-connection.js'
import { createMineflayerBot } from './bot/mineflayer-bot-factory.js'
import { MineflayerContainerAccess } from './bot/mineflayer-container-access.js'
import { MineflayerDeathWatcher } from './bot/mineflayer-death-watcher.js'
import { MineflayerDigger } from './bot/mineflayer-digger.js'
import { MineflayerDroppedItems } from './bot/mineflayer-dropped-items.js'
import { MineflayerGaze } from './bot/mineflayer-gaze.js'
import { MineflayerInventoryWriter } from './bot/mineflayer-inventory-writer.js'
import { MineflayerEater } from './bot/mineflayer-eater.js'
import { MineflayerEntityScanner } from './bot/mineflayer-entity-scanner.js'
import { MineflayerFoodCatalog } from './bot/mineflayer-food-catalog.js'
import { MineflayerFurnaceAccess } from './bot/mineflayer-furnace.js'
import { MineflayerInventory } from './bot/mineflayer-inventory.js'
import { MineflayerItemFacts } from './bot/mineflayer-item-facts.js'
import { MineflayerLocomotion } from './bot/mineflayer-locomotion.js'
import { MineflayerLookTarget } from './bot/mineflayer-look-target.js'
import { MineflayerDoorAccess } from './bot/mineflayer-door-access.js'
import { MineflayerSwitchAccess } from './bot/mineflayer-switch-access.js'
import { MineflayerCropAccess } from './bot/mineflayer-crop-access.js'
import { MineflayerTiller } from './bot/mineflayer-tiller.js'
import { MineflayerRailAccess } from './bot/mineflayer-rail-access.js'
import { MineflayerMinecarts } from './bot/mineflayer-minecarts.js'
import { MineflayerBucketFiller } from './bot/mineflayer-bucket-filler.js'
import { MineflayerAnimalInteraction } from './bot/mineflayer-animal-interaction.js'
import { MineflayerNavigator } from './bot/mineflayer-navigator.js'
import { MineflayerLightReader } from './bot/mineflayer-light-reader.js'
import { MineflayerPlacer } from './bot/mineflayer-placer.js'
import { MineflayerRecipes } from './bot/mineflayer-recipes.js'
import { MineflayerServerCommands } from './bot/mineflayer-server-commands.js'
import { MineflayerVitals } from './bot/mineflayer-vitals.js'
import { MineflayerBiomeReader } from './bot/mineflayer-biome-reader.js'
import { MinecraftServerStatusProbe } from './bot/minecraft-status-probe.js'
import { MineflayerWorldIdentifier } from './bot/mineflayer-world-identifier.js'
import { createPathGoals } from './bot/path-goals.js'
import { MineflayerPathDriver, type GoalFactory } from './bot/path-driver.js'
import { UdpLanDiscovery } from './bot/udp-lan-discovery.js'
import type { Config } from './config/config.types.js'
import type { Clock } from './core/clock.port.js'
import type { Connection } from './core/connection.port.js'
import type { DatagramSocketFactory } from './core/datagram-socket.port.js'
import type { Logger } from './core/logger.js'
import type { Random } from './core/random.port.js'
import type { ResumeDescriptor } from './tasks/task.types.js'
import type { ServerStatusProbe } from './core/server-status.port.js'
import type { Scheduler } from './core/scheduler.port.js'
import type { StopHandler } from './core/stop-handler.port.js'
import { StderrLogger } from './infra/stderr-logger.js'
import { SystemClock } from './infra/system-clock.js'
import { SystemRandom } from './infra/system-random.js'
import { SystemScheduler } from './infra/system-scheduler.js'
import { createUdpSocket } from './infra/udp-socket.js'
import { createMcpServer } from './mcp/mcp-server.js'
import { TaskLauncher } from './mcp/task-launcher.js'
import { ToolRegistry } from './mcp/tool-registry.js'
import { ConnectTool } from './mcp/tools/connect-tool.js'
import { DisconnectTool } from './mcp/tools/disconnect-tool.js'
import {
  DiscardInterruptedTaskTool,
  ResumeInterruptedTaskTool,
  type ToolInvoker,
} from './mcp/tools/journal-tools.js'
import { FindBlocksTool } from './mcp/tools/find-blocks-tool.js'
import { FollowPlayerTool } from './mcp/tools/follow-player-tool.js'
import { GetInventoryTool } from './mcp/tools/get-inventory-tool.js'
import { GetNearbyEntitiesTool } from './mcp/tools/get-nearby-entities-tool.js'
import { GetPlayerPositionTool } from './mcp/tools/get-player-position-tool.js'
import { GetStatusTool } from './mcp/tools/get-status-tool.js'
import { GoToTool } from './mcp/tools/goto-tool.js'
import { LookAroundTool } from './mcp/tools/look-around-tool.js'
import {
  ForgetTool,
  GetRecentHistoryTool,
  RecallTool,
  RememberTool,
  RemoveStandingInstructionTool,
  SetStandingInstructionTool,
} from './mcp/tools/memory-tools.js'
import { SayTool } from './mcp/tools/say-tool.js'
import { CancelTaskTool, GetTaskStatusTool, StopTool } from './mcp/tools/task-tools.js'
import { DropItemsTool, GiveItemsTool, ResolveItemTool } from './mcp/tools/handover-tools.js'
import {
  ListDeathRecordsTool,
  RecoverDropsTool,
  SetDropRecoveryPolicyTool,
  SkipDropRecoveryTool,
} from './mcp/tools/drop-recovery-tools.js'
import { AttackEntityTool } from './mcp/tools/attack-entity-tool.js'
import { HuntAnimalsTool } from './mcp/tools/hunt-animals-tool.js'
import { ListHuntableAnimalsTool } from './mcp/tools/list-huntable-animals-tool.js'
import { SetFoodPolicyTool } from './mcp/tools/set-food-policy-tool.js'
import { PressSwitchTool } from './mcp/tools/press-switch-tool.js'
import { OpenDoorTool } from './mcp/tools/open-door-tool.js'
import { FindSwitchesTool } from './mcp/tools/find-switches-tool.js'
import { SetSwitchPolicyTool } from './mcp/tools/set-switch-policy-tool.js'
import {
  ListBedsTool,
  PlaceBedTool,
  SetRespawnPointTool,
  SetSleepPolicyTool,
  SleepTool,
} from './mcp/tools/sleeping-tools.js'
import {
  LabelContainerTool,
  ListContainersTool,
  RegisterContainerTool,
  RemoveContainerTool,
} from './mcp/tools/container-tools.js'
import {
  ListStorageRulesTool,
  RemoveStorageRuleTool,
  SetStorageRuleTool,
} from './mcp/tools/storage-rule-tools.js'
import {
  DepositItemsTool,
  FindItemsTool,
  ScanContainersTool,
  WithdrawItemsTool,
} from './mcp/tools/storage-task-tools.js'
import { ResumeTaskTool, SetStoragePolicyTool } from './mcp/tools/storage-policy-tools.js'
import {
  BuildTool,
  ListBlueprintsTool,
  PlaceBlockTool,
  PreviewBuildTool,
} from './mcp/tools/build-tools.js'
import {
  ExcavateTool,
  ListExcavationsTool,
  PreviewExcavationTool,
} from './mcp/tools/excavation-tools.js'
import { FlattenAreaTool, PreviewFlattenTool } from './mcp/tools/site-leveling-tools.js'
import {
  BreedAnimalsTool,
  BuildFarmTool,
  CollectEggsTool,
  CollectSaplingsTool,
  DiscoverFarmTool,
  HarvestCropsTool,
  HarvestTreesTool,
  InspectFarmTool,
  ListFarmsTool,
  LureAnimalsTool,
  PlantCropsTool,
  PlantTreesTool,
  RegisterFarmTool,
  SetEggPolicyTool,
  TendFarmTool,
} from './mcp/tools/farming-tools.js'
import { BuildRailwayTool, PlaceMinecartTool, PlanRailwayTool } from './mcp/tools/railway-tools.js'
import { FillBucketTool } from './mcp/tools/fill-bucket-tool.js'
import { BreakBlockTool } from './mcp/tools/break-block-tool.js'
import { CollectBlockTool } from './mcp/tools/collect-block-tool.js'
import { CraftTool } from './mcp/tools/craft-tool.js'
import { ListRecipesTool } from './mcp/tools/list-recipes-tool.js'
import { PickupItemsTool } from './mcp/tools/pickup-items-tool.js'
import {
  ListProtectedAreasTool,
  ProtectAreaTool,
  UnprotectAreaTool,
} from './mcp/tools/protected-area-tools.js'
import { SmeltTool } from './mcp/tools/smelt-tool.js'
import { TeleportToPlayerTool, TeleportToPositionTool } from './mcp/tools/teleport-tools.js'
import {
  GetSessionBriefingTool,
  ListWorldsTool,
  SetWorldProfileTool,
} from './mcp/tools/world-tools.js'
import { WaitForChatTool } from './mcp/tools/wait-for-chat-tool.js'
import { WhisperTool } from './mcp/tools/whisper-tool.js'
import { BlockFinder } from './perception/block-finder.js'
import { SurroundingsDescriber } from './perception/surroundings.js'
import { AutoEat } from './reflexes/auto-eat.js'
import { AvoidLava } from './reflexes/avoid-lava.js'
import { Drowning } from './reflexes/drowning.js'
import { ReflexEngine } from './reflexes/reflex-engine.js'
import { SafeSpotFinder } from './reflexes/safe-spot.js'
import { ThreatResponse } from './reflexes/threat-response.js'
import { SessionService } from './session/session-service.js'
import { FileStateStore } from './state/file-state-store.js'
import { describeToolCall } from './state/history-format.js'
import { ContainerIndex } from './state/container-index.js'
import { EggPolicy } from './state/egg-policy.js'
import { ExcavationRecords } from './state/excavation-records.js'
import { FarmRegistry } from './state/farm-registry.js'
import { DropRecords } from './state/drop-records.js'
import { RailwayLog } from './state/railway-log.js'
import { BedRegistry } from './state/bed-registry.js'
import { SignRegistry } from './state/sign-registry.js'
import { WorldKnowledgeStore } from './knowledge/world-knowledge-store.js'
import { ExploreForStructureSkill } from './skills/discovery/explore-for-structure-skill.js'
import { defaultSignatures } from './skills/discovery/structure-signatures.js'
import { StructureScanner } from './skills/discovery/structure-scanner.js'
import {
  ExploreForStructureTool,
  ListKnownStructuresTool,
  ListLandmarksTool,
  RemoveLandmarkTool,
  SetLandmarkTool,
} from './mcp/tools/discovery-tools.js'
import { SleepPolicy } from './state/sleep-policy.js'
import { DropRecoveryPolicy } from './state/drop-recovery-policy.js'
import { FoodPolicy } from './state/food-policy.js'
import { SwitchPolicy } from './state/switch-policy.js'
import { InstructionLog } from './state/instruction-log.js'
import { NotesStore } from './state/notes-store.js'
import { ProtectedAreas } from './state/protected-areas.js'
import { StoragePolicy } from './state/storage-policy.js'
import { StorageRules } from './state/storage-rules.js'
import { SessionBriefingBuilder } from './state/session-briefing.js'
import { StandingInstructions } from './state/standing-instructions.js'
import { TaskJournal } from './state/task-journal.js'
import { WorldRegistry } from './state/world-registry.js'
import { WorldStateManager } from './state/world-state-manager.js'
import { BlueprintRegistry } from './skills/building/blueprint-registry.js'
import { BuildSkill } from './skills/building/build-skill.js'
import { StorageMaterialFetcher } from './skills/building/material-fetcher.js'
import {
  BoxProvider,
  FloorProvider,
  SingleBlockProvider,
  SolidProvider,
  WallsProvider,
} from './skills/building/providers/basic-providers.js'
import { CustomBlueprintProvider } from './skills/building/providers/custom-provider.js'
import { ShelterProvider, SmallHouseProvider } from './skills/building/providers/house-providers.js'
import { HazardRule } from './skills/construction/hazard-rule.js'
import { PlanExecutor } from './skills/construction/plan-executor.js'
import { CraftingSupplies } from './skills/construction/crafting-supplies.js'
import { Scaffolder } from './skills/construction/scaffolder.js'
import { SpoilDiscarder } from './skills/construction/spoil-discarder.js'
import { SiteSafety } from './skills/construction/site-safety.js'
import { StandingSpotChooser } from './skills/construction/standing-spot.js'
import { ExcavateSkill } from './skills/excavation/excavate-skill.js'
import { ExcavationRegistry } from './skills/excavation/excavation-registry.js'
import {
  PitProvider,
  QuarryProvider,
  ShaftProvider,
} from './skills/excavation/providers/dig-down.js'
import { DigToProvider } from './skills/excavation/providers/dig-to.js'
import { RoomProvider } from './skills/excavation/providers/room.js'
import {
  BranchMineProvider,
  StaircaseDownProvider,
  TunnelProvider,
} from './skills/excavation/providers/tunnels.js'
import { WallTarget } from './skills/excavation/wall-target.js'
import { FlattenAreaSkill } from './skills/site-leveling/flatten-area-skill.js'
import { MarkerFinder } from './skills/site-leveling/marker-finder.js'
import { BreedAnimalsSkill } from './skills/farming/breed-animals-skill.js'
import { BuildFarmSkill } from './skills/farming/build-farm-skill.js'
import { CollectEggsSkill } from './skills/farming/collect-eggs-skill.js'
import { CollectSaplingsSkill } from './skills/farming/collect-saplings-skill.js'
import { DiscoverFarmSkill } from './skills/farming/discover-farm-skill.js'
import { EggThrower } from './skills/farming/egg-thrower.js'
import { FarmLayoutRegistry } from './skills/farming/farm-layout-registry.js'
import { GroveSpotFinder } from './skills/farming/grove-spots.js'
import { HarvestCropsSkill } from './skills/farming/harvest-crops-skill.js'
import { HarvestTreesSkill } from './skills/farming/harvest-trees-skill.js'
import { HerdManager } from './skills/farming/herd-manager.js'
import { InspectFarmSkill } from './skills/farming/inspect-farm-skill.js'
import { LureAnimalsSkill } from './skills/farming/lure-animals-skill.js'
import { PenGateGuard } from './skills/farming/pen-gate-guard.js'
import { PlantCropsSkill } from './skills/farming/plant-crops-skill.js'
import { PlantTreesSkill } from './skills/farming/plant-trees-skill.js'
import { AnimalPenProvider } from './skills/farming/providers/animal-pen.js'
import { CropFieldProvider } from './skills/farming/providers/crop-field.js'
import { TendFarmSkill } from './skills/farming/tend-farm-skill.js'
import { BuildRailwaySkill } from './skills/railway/build-railway-skill.js'
import { PlaceMinecartSkill } from './skills/railway/place-minecart-skill.js'
import { FillBucketSkill } from './skills/buckets/fill-bucket-skill.js'
import { BreakBlockSkill } from './skills/breaking/break-block-skill.js'
import { LiquidSpotFinder } from './skills/buckets/liquid-spot.js'
import { MineflayerBedAccess } from './bot/mineflayer-bed-access.js'
import { MineflayerSignAccess } from './bot/mineflayer-sign-access.js'
import { EditSignSkill } from './skills/signs/edit-sign-skill.js'
import { PlaceSignSkill } from './skills/signs/place-sign-skill.js'
import { RemoveSignSkill } from './skills/signs/remove-sign-skill.js'
import { SignReader } from './skills/signs/sign-reader.js'
import { SignSupplies } from './skills/signs/sign-supplies.js'
import { SignTargeter } from './skills/signs/sign-target.js'
import { EditSignTool, PlaceSignTool, ReadSignsTool, RemoveSignTool } from './mcp/tools/sign-tools.js'
import { MineflayerSleeper } from './bot/mineflayer-sleeper.js'
import { BedFinder } from './skills/sleeping/bed-finder.js'
import { NightResponder } from './skills/sleeping/night-responder.js'
import { NightWatch } from './skills/sleeping/night-watch.js'
import { PlaceBedSkill } from './skills/sleeping/place-bed-skill.js'
import { SetRespawnPointSkill } from './skills/sleeping/set-respawn-point-skill.js'
import { SleepSkill } from './skills/sleeping/sleep-skill.js'
import { RailRoutePlanner } from './skills/railway/rail-route-planner.js'
import { RailVerifier } from './skills/railway/rail-verifier.js'
import { CraftItemSkill } from './skills/crafting/craft-item-skill.js'
import { PlacementSpotFinder } from './skills/crafting/placement-spot.js'
import { RecipePlanner } from './skills/crafting/recipe-planner.js'
import { Workstations } from './skills/crafting/workstations.js'
import { CollectBlocksSkill } from './skills/gathering/collect-blocks-skill.js'
import { StructuredGatherSkill } from './skills/gathering/structured-gather-skill.js'
import { DropCollector } from './skills/gathering/drop-collector.js'
import { PickupItemsSkill } from './skills/gathering/pickup-items-skill.js'
import { AttackEntitySkill } from './skills/hunting/attack-entity-skill.js'
import { HUNTABLE_SPECIES_NAMES } from './skills/hunting/animal-catalog.js'
import { HuntAnimalsSkill } from './skills/hunting/hunt-animals-skill.js'
import { LowFoodResponder } from './skills/hunting/low-food-responder.js'
import { PenDetector } from './skills/hunting/pen-detector.js'
import { SmeltItemsSkill } from './skills/smelting/smelt-items-skill.js'
import { TeleportSkill } from './skills/commands/teleport-skill.js'
import { AutoRecovery } from './skills/recovery/auto-recovery.js'
import { DeathResponder } from './skills/recovery/death-responder.js'
import { DropIgnoreList } from './skills/recovery/drop-ignore-list.js'
import { HazardAssessor } from './skills/recovery/hazard-assessor.js'
import { RecoverDropsSkill } from './skills/recovery/recover-drops-skill.js'
import { UnclaimedDropHandler } from './skills/recovery/unclaimed-drops.js'
import { DropItemsSkill } from './skills/handover/drop-items-skill.js'
import { DropSpot } from './skills/handover/drop-spot.js'
import { GiveItemsSkill } from './skills/handover/give-items-skill.js'
import { ItemResolver } from './skills/handover/item-resolver.js'
import { ItemThrower } from './skills/handover/item-thrower.js'
import { ContainerSelector } from './skills/storage/container-selector.js'
import { ContainerVisitor } from './skills/storage/container-visitor.js'
import { DepositItemsSkill } from './skills/storage/deposit-items-skill.js'
import { FindItemsSkill } from './skills/storage/find-items-skill.js'
import { InventoryFullHandler } from './skills/storage/inventory-full-handler.js'
import { ScanContainersSkill } from './skills/storage/scan-containers-skill.js'
import { WithdrawItemsSkill } from './skills/storage/withdraw-items-skill.js'
import { DoorOpeningNavigator } from './skills/movement/door-opening-navigator.js'
import { FollowPlayerSkill } from './skills/movement/follow-player-skill.js'
import { GoToSkill } from './skills/movement/goto-skill.js'
import { IronDoorOpener } from './skills/movement/iron-door-opener.js'
import { PolicyIronDoorHandler } from './skills/movement/iron-door-handler.js'
import { OpenDoorSkill } from './skills/movement/open-door-skill.js'
import { PressSwitchSkill } from './skills/movement/press-switch-skill.js'
import { SwitchFinder } from './skills/movement/switch-finder.js'
import { TaskManager } from './tasks/task-manager.js'

/** A record tried this often is not tried again without the player's say-so. */
const DEFAULT_RECOVERY_ATTEMPTS = 2
/** When a task or reflex keeps the bot busy, an automatic recovery tries again this often, for about 3 minutes. */
const RECOVERY_RETRY_MS = 5_000
const RECOVERY_RETRIES = 36
/** How often the bot checks whether night has fallen (for the sleep policy). */
const NIGHT_CHECK_MS = 5_000

/** The low-level seams. Tests replace them; production uses the real implementations. */
export interface AppDeps {
  readonly logger: Logger
  readonly clock: Clock
  readonly random: Random
  readonly scheduler: Scheduler
  /** Creates the game bot. Tests pass a stub bot factory. */
  readonly botFactory: BotFactory
  /** Creates the UDP socket that listens for LAN world announcements. */
  readonly socketFactory: DatagramSocketFactory
  /** Reads a server's message of the day, to name its world. Tests pass a stub. */
  readonly statusProbe: ServerStatusProbe
  /** Creates the pathfinder's goal objects. Tests pass a stub. */
  readonly pathGoals: GoalFactory
  /** What the owner's "stop" cancels. Defaults to the task manager. */
  readonly stopHandler: StopHandler
}

export interface App {
  readonly config: Config
  readonly logger: Logger
  readonly clock: Clock
  readonly random: Random
  readonly connection: Connection
  readonly inbox: AgentInbox
  readonly session: SessionService
  readonly tasks: TaskManager
  readonly worldState: WorldStateManager
  readonly reflexes: ReflexEngine
  readonly registry: ToolRegistry
  readonly mcpServer: McpServer
  /** Serves MCP over the given transport (stdio in production, in-memory in tests). */
  serve(transport: Transport): Promise<void>
  /** Disconnects the bot and closes the MCP server. */
  shutdown(): Promise<void>
}

/**
 * Composition root: the only place that wires concrete classes together.
 * Creating the app has no side effects (no I/O, no timers), so tests can build it with fakes.
 */
export function createApp(config: Config, overrides: Partial<AppDeps> = {}): App {
  const clock = overrides.clock ?? new SystemClock()
  const random = overrides.random ?? new SystemRandom()
  const scheduler = overrides.scheduler ?? new SystemScheduler()
  const logger = overrides.logger ?? new StderrLogger({ level: config.logLevel, clock })
  const botFactory = overrides.botFactory ?? createMineflayerBot
  const socketFactory = overrides.socketFactory ?? createUdpSocket
  const pathGoals = overrides.pathGoals ?? createPathGoals()
  const statusProbe = overrides.statusProbe ?? new MinecraftServerStatusProbe()

  const connection = new MineflayerConnection({ factory: botFactory, scheduler, logger })
  const chat = new MineflayerChat(connection)
  const vitals = new MineflayerVitals(connection)
  const blocks = new MineflayerBlockScanner(connection)
  const entities = new MineflayerEntityScanner(connection)
  const inventory = new MineflayerInventory(connection)
  const paths = new MineflayerPathDriver(connection, pathGoals)
  const rawNavigator = new MineflayerNavigator({
    holder: connection,
    driver: paths,
    entities,
    clock,
    scheduler,
  })
  const doors = new MineflayerDoorAccess(connection)
  const switches = new MineflayerSwitchAccess(connection)
  const cropAccess = new MineflayerCropAccess(connection)
  const tiller = new MineflayerTiller(connection)
  const switchFinder = new SwitchFinder(blocks)
  const switchPolicy = new SwitchPolicy()
  // Walks to a candidate switch with the raw navigator, never the wrapped one below: DoorOpeningNavigator
  // hands it an iron door to solve, so it must not call back into itself.
  const ironDoorOpener = new IronDoorOpener(switchFinder, switches, doors, rawNavigator)
  const ironDoorHandler = new PolicyIronDoorHandler(switchPolicy, switchFinder, ironDoorOpener)
  const navigator = new DoorOpeningNavigator({
    inner: rawNavigator,
    blocks,
    doors,
    logger,
    ironDoors: ironDoorHandler,
  })
  const tasks = new TaskManager({ clock, scheduler, logger })
  const stopHandler = overrides.stopHandler ?? tasks
  const lanDiscovery = new UdpLanDiscovery(socketFactory, scheduler)

  // Everything that belongs to one world profile, saved under DATA_DIR/<profile>/.
  const notes = new NotesStore(clock)
  const history = new InstructionLog(clock)
  const standing = new StandingInstructions()
  const protectedAreas = new ProtectedAreas()
  const foodPolicy = new FoodPolicy()
  const containerIndex = new ContainerIndex(clock)
  const farmRegistry = new FarmRegistry(clock)
  const excavationRecords = new ExcavationRecords(clock)
  const eggPolicy = new EggPolicy()
  const railwayLog = new RailwayLog(clock)
  const bedRegistry = new BedRegistry(clock)
  const signRegistry = new SignRegistry(clock)
  const knowledge = new WorldKnowledgeStore(clock)
  const sleepPolicy = new SleepPolicy()
  const storageRules = new StorageRules()
  const storagePolicy = new StoragePolicy()
  const dropRecords = new DropRecords(clock)
  const dropPolicy = new DropRecoveryPolicy()
  const journal = new TaskJournal(clock, tasks)
  const worldState = new WorldStateManager({
    registry: new WorldRegistry({
      store: new FileStateStore({ directory: config.dataDir, scheduler, logger }),
      clock,
    }),
    storeForProfile: (profile) =>
      new FileStateStore({ directory: path.join(config.dataDir, profile), scheduler, logger }),
    components: [
      notes,
      history,
      standing,
      journal,
      protectedAreas,
      foodPolicy,
      switchPolicy,
      containerIndex,
      farmRegistry,
      excavationRecords,
      eggPolicy,
      railwayLog,
      bedRegistry,
      signRegistry,
      knowledge,
      sleepPolicy,
      storageRules,
      storagePolicy,
      dropRecords,
      dropPolicy,
    ],
    logger,
  })
  // Survival reflexes: run by themselves, with no round trip to the agent.
  const combatant = new MeleeCombatant({
    driver: new MineflayerCombatDriver(connection, paths),
    scheduler,
    clock,
  })
  const locomotion = new MineflayerLocomotion(connection)
  const safeSpots = new SafeSpotFinder(blocks)
  const invokeResume = async (resume: ResumeDescriptor): Promise<boolean> =>
    (
      await invoke(
        resume.tool,
        { ...resume.arguments, wait_seconds: 0 },
        { signal: new AbortController().signal },
      )
    ).ok
  // What to do when the bot is hungry with nothing to eat: the player's standing food policy, applied in code.
  const lowFood = new LowFoodResponder({
    policy: foodPolicy,
    emit: (type, message) => {
      inbox.pushEvent({ type, message })
    },
    startHunt: async () => {
      const result = await invoke(
        'hunt_animals',
        { species: HUNTABLE_SPECIES_NAMES, count: 3, cook: true, wait_seconds: 0 },
        { signal: new AbortController().signal },
      )
      return { ok: result.ok, message: result.ok ? '' : result.error }
    },
    stopTask: async () => {
      await tasks.cancel(undefined, 'requested')
    },
    scheduler,
  })
  const sleeper = new MineflayerSleeper(connection)
  const reflexes = new ReflexEngine({
    reflexes: [
      new AvoidLava({ blocks, navigator, locomotion, safeSpots }),
      new Drowning({ navigator, locomotion, safeSpots }),
      new ThreatResponse({
        combatant,
        navigator,
        entities,
        lowHealthThreshold: config.lowHealthThreshold,
        owner: config.owner,
      }),
      new AutoEat({
        inventory,
        catalog: new MineflayerFoodCatalog(connection),
        eater: new MineflayerEater(connection),
        onNoFood: () => {
          lowFood.respond()
        },
      }),
    ],
    vitals,
    entities,
    tasks,
    resume: invokeResume,
    sleeper,
    emit: (message) => {
      inbox.pushEvent({ type: 'reflex', message })
    },
    scheduler,
    clock,
    logger,
  })
  const briefing = new SessionBriefingBuilder({
    clock,
    worldState,
    journal,
    notes,
    standing,
    history,
    drops: dropRecords,
  })

  const inbox = new AgentInbox({
    clock,
    scheduler,
    onMessage: (message) => {
      history.record(
        'chat',
        `${message.sender}${message.whisper ? ' (whisper)' : ''}: ${message.text}`,
      )
    },
    onEvent: (event) => {
      history.record('event', `${event.type}: ${event.message}`)
    },
  })
  // A task that waits for the player's decision tells the agent, who asks the player.
  tasks.onEvent((event) => {
    if (event.type !== 'waiting' || event.snapshot.pending === undefined) return
    inbox.pushEvent({
      type: 'needs_decision',
      message: `Task ${event.snapshot.id} (${event.snapshot.description}) is waiting: ${event.snapshot.pending.message} Options: ${event.snapshot.pending.options.join(', ')}.`,
    })
  })
  // Sleeping: beds, the respawn point, and what the bot does at nightfall.
  const bedAccess = new MineflayerBedAccess(connection, scheduler)
  const bedFinder = new BedFinder(blocks, bedRegistry)
  const sleepSkill = new SleepSkill({
    vitals,
    blocks,
    entities,
    navigator,
    sleeper,
    finder: bedFinder,
    registry: bedRegistry,
    clock,
    scheduler,
  })
  const setRespawnPoint = new SetRespawnPointSkill({
    vitals,
    blocks,
    navigator,
    beds: bedAccess,
    sleeper,
    finder: bedFinder,
    registry: bedRegistry,
  })
  const placeBed = new PlaceBedSkill({
    vitals,
    blocks,
    inventory,
    navigator,
    placer: new MineflayerPlacer(connection),
    gaze: new MineflayerGaze(connection),
    guard: protectedAreas,
    registry: bedRegistry,
    scheduler,
  })
  const nightResponder = new NightResponder({
    policy: sleepPolicy,
    vitals,
    registry: bedRegistry,
    busy: () =>
      tasks.current() !== undefined ||
      reflexes.activeReflex() !== undefined ||
      entities.nearby(16).some((entity) => entity.category === 'hostile'),
    emit: (type, message) => {
      inbox.pushEvent({ type, message })
    },
    startSleep: async () => {
      const result = await invoke('sleep', { wait_seconds: 0 }, { signal: new AbortController().signal })
      return { ok: result.ok, message: result.ok ? '' : result.error }
    },
    clock,
  })
  const nightWatch = new NightWatch(() => nightResponder.tick(), scheduler, NIGHT_CHECK_MS)
  const router = new ChatRouter({
    inbox,
    logger,
    owner: config.owner,
    commands: [new StopCommand(stopHandler)],
  })
  chat.onMessage((message) => {
    router.handle(message)
  })
  connection.onEvent((event) => {
    if (event.type === 'disconnected' || event.type === 'kicked') {
      void reflexes.stop()
      nightWatch.stop()
      // Cancel first, so the journal records the tasks as interrupted, then release the world's state.
      void tasks.cancel(undefined, 'disconnected').then(() => worldState.close())
    }
    switch (event.type) {
      case 'connected':
        if (config.reflexesEnabled) reflexes.start()
        nightWatch.start()
        inbox.pushEvent({ type: 'connected', message: `Bot ${event.username} joined the world.` })
        break
      case 'disconnected':
        inbox.pushEvent({ type: 'disconnected', message: `Disconnected: ${event.reason}` })
        break
      case 'kicked':
        inbox.pushEvent({ type: 'kicked', message: `Kicked from the server: ${event.reason}` })
        break
      case 'error':
        inbox.pushEvent({ type: 'error', message: `Connection error: ${event.message}` })
        break
    }
  })

  const session = new SessionService({
    config,
    connection,
    lanDiscovery,
    logger,
    identifier: new MineflayerWorldIdentifier(connection, statusProbe),
    worldState,
  })
  const blockFinder = new BlockFinder(blocks)

  // Gathering, crafting, and smelting.
  const drops = new MineflayerDroppedItems(connection)
  const recipes = new MineflayerRecipes(connection)
  const planner = new RecipePlanner(recipes)
  const workstations = new Workstations({
    blocks,
    navigator,
    placer: new MineflayerPlacer(connection),
    inventory,
    vitals,
    spots: new PlacementSpotFinder(blocks),
  })
  // What the bot threw away on purpose is never picked up again (junk from a dig, `drop_items`).
  const dropIgnore = new DropIgnoreList(clock)
  const dropCollector = new DropCollector({
    drops,
    navigator,
    scheduler,
    skip: (item) => dropIgnore.isIgnored(item),
  })
  // Storage: containers, rules, and what to do when the inventory is full.
  const itemFacts = new MineflayerItemFacts(connection)
  const visitor = new ContainerVisitor({
    blocks,
    navigator,
    containers: new MineflayerContainerAccess(connection, itemFacts),
    index: containerIndex,
  })
  const selector = new ContainerSelector(containerIndex, storageRules, itemFacts)
  const depositItems = new DepositItemsSkill({
    inventory,
    vitals,
    index: containerIndex,
    selector,
    visitor,
    facts: itemFacts,
  })
  const scanContainers = new ScanContainersSkill({ vitals, index: containerIndex, visitor })
  const withdrawItems = new WithdrawItemsSkill({
    inventory,
    vitals,
    index: containerIndex,
    visitor,
    facts: itemFacts,
  })
  const findItems = new FindItemsSkill({
    index: containerIndex,
    scanner: scanContainers,
    facts: itemFacts,
  })
  // Drop recovery: after a death, and for items nobody picked up.
  const recoverDrops = new RecoverDropsSkill({
    records: dropRecords,
    inventory,
    vitals,
    navigator,
    collector: dropCollector,
    hazards: new HazardAssessor(blocks, entities),
    combatant,
    ignore: dropIgnore,
    clock,
    scheduler,
  })
  const autoRecovery = new AutoRecovery({
    tasks,
    recoverer: recoverDrops,
    records: dropRecords,
    activeReflex: () => reflexes.activeReflex(),
    emit: (type, message) => {
      inbox.pushEvent({ type, message })
    },
    say: (text) => {
      chat.say(text)
    },
    scheduler,
    maxAttempts: DEFAULT_RECOVERY_ATTEMPTS,
    retryDelayMs: RECOVERY_RETRY_MS,
    maxTries: RECOVERY_RETRIES,
  })
  const unclaimedDrops = new UnclaimedDropHandler({
    records: dropRecords,
    policy: dropPolicy,
    recovery: autoRecovery,
    emit: (type, message) => {
      inbox.pushEvent({ type, message })
    },
    waitMs: config.unclaimedDropWaitSeconds * 1000,
    clock,
    scheduler,
  })
  const deathResponder = new DeathResponder({
    watcher: new MineflayerDeathWatcher(connection, clock),
    beds: bedRegistry,
    whereIsBot: () => {
      const now = vitals.read()
      return now === undefined ? undefined : { position: now.position, dimension: now.dimension }
    },
    records: dropRecords,
    policy: dropPolicy,
    recovery: autoRecovery,
    cancelTasks: async () => {
      await tasks.cancel(undefined, 'died')
    },
    emit: (type, message) => {
      inbox.pushEvent({ type, message })
    },
    say: (text) => {
      chat.say(text)
    },
    clock,
    scheduler,
  })
  deathResponder.start()
  // Handing items over.
  const dropSpot = new DropSpot(blocks)
  const thrower = new ItemThrower(new MineflayerInventoryWriter(connection), scheduler)
  const giveItems = new GiveItemsSkill({
    inventory,
    index: containerIndex,
    withdrawer: withdrawItems,
    depositor: depositItems,
    scanner: scanContainers,
    navigator,
    entities,
    blocks,
    gaze: new MineflayerGaze(connection),
    thrower,
    spot: dropSpot,
    drops,
    scheduler,
    vitals,
    facts: itemFacts,
    unclaimed: unclaimedDrops,
    clock,
  })
  const dropItems = new DropItemsSkill({
    inventory,
    navigator,
    blocks,
    thrower,
    spot: dropSpot,
    vitals,
    facts: itemFacts,
    ignore: dropIgnore,
  })
  const inventoryFull = new InventoryFullHandler({
    policy: storagePolicy,
    depositor: depositItems,
    navigator,
    vitals,
    inventory,
  })
  const collectBlocks = new CollectBlocksSkill({
    blocks,
    finder: blockFinder,
    digger: new MineflayerDigger(connection),
    navigator,
    inventory,
    vitals,
    drops: dropCollector,
    guard: protectedAreas,
    full: inventoryFull,
  })
  // Saplings come from breaking leaves, on request only (collect_saplings, or `saplings` on collect_block).
  const collectSaplings = new CollectSaplingsSkill({
    blocks,
    inventory,
    leaves: collectBlocks,
    drops: dropCollector,
  })
  const craftItem = new CraftItemSkill({
    book: recipes,
    planner,
    crafter: recipes,
    inventory,
    workstations,
    scheduler,
  })
  // Construction: one engine (plans of block operations) and building as its first client.
  const constructionPlacer = new MineflayerPlacer(connection)
  const constructionDigger = new MineflayerDigger(connection)
  const planExecutor = new PlanExecutor({
    blocks,
    placer: constructionPlacer,
    digger: constructionDigger,
    navigator,
    inventory,
    vitals,
    guard: protectedAreas,
    drops: dropCollector,
    spots: new StandingSpotChooser(blocks),
    safety: new SiteSafety(blocks, new MineflayerLightReader(connection)),
    scheduler,
    full: inventoryFull,
    hazard: new HazardRule(blocks),
    discarder: new SpoilDiscarder({ inventory, thrower, vitals, ignore: dropIgnore }),
    supplies: new CraftingSupplies(craftItem),
    tiller,
    scaffolder: new Scaffolder({
      blocks,
      placer: constructionPlacer,
      digger: constructionDigger,
      locomotion,
      navigator,
      vitals,
      guard: protectedAreas,
      drops: dropCollector,
      scheduler,
    }),
  })
  const blueprints = new BlueprintRegistry()
    .register(new FloorProvider())
    .register(new WallsProvider())
    .register(new BoxProvider())
    .register(new SolidProvider())
    .register(new SingleBlockProvider())
    .register(new SmallHouseProvider())
    .register(new ShelterProvider())
    .register(new CustomBlueprintProvider())
  const buildSkill = new BuildSkill({
    registry: blueprints,
    executor: planExecutor,
    vitals,
    fetcher: new StorageMaterialFetcher({
      inventory,
      withdrawer: withdrawItems,
      scanner: scanContainers,
    }),
  })
  const materialFetcher = new StorageMaterialFetcher({
    inventory,
    withdrawer: withdrawItems,
    scanner: scanContainers,
  })
  const lookTarget = new MineflayerLookTarget(connection)
  const wallTarget = new WallTarget(lookTarget, blocks, entities)
  // Signs: put up, change, take down, and read, named by what the player looks at or points to.
  const signAccess = new MineflayerSignAccess(connection, scheduler)
  const signReader = new SignReader(blocks, signAccess, signRegistry)
  const signTargeter = new SignTargeter(blocks, lookTarget, signReader)
  const placeSign = new PlaceSignSkill({
    vitals,
    blocks,
    signs: signAccess,
    navigator,
    placer: constructionPlacer,
    guard: protectedAreas,
    supplies: new SignSupplies({
      inventory,
      index: containerIndex,
      fetcher: materialFetcher,
      crafter: new CraftingSupplies(craftItem),
    }),
    registry: signRegistry,
    scheduler,
    digger: constructionDigger,
  })
  const editSign = new EditSignSkill({
    signs: signAccess,
    navigator,
    guard: protectedAreas,
    registry: signRegistry,
    scheduler,
  })
  const removeSign = new RemoveSignSkill({
    blocks,
    signs: signAccess,
    navigator,
    digger: constructionDigger,
    drops: dropCollector,
    inventory,
    guard: protectedAreas,
    registry: signRegistry,
  })
  const pressSwitch = new PressSwitchSkill({ blocks, switches, doors, navigator })
  const openDoor = new OpenDoorSkill({ blocks, doors, navigator, opener: ironDoorOpener, vitals })
  const excavations = new ExcavationRegistry()
    .register(new PitProvider())
    .register(new ShaftProvider())
    .register(new QuarryProvider())
    .register(new TunnelProvider())
    .register(new BranchMineProvider())
    .register(new StaircaseDownProvider())
    .register(new RoomProvider())
    .register(new DigToProvider())
  const excavateSkill = new ExcavateSkill({
    registry: excavations,
    executor: planExecutor,
    vitals,
    fetcher: materialFetcher,
    records: excavationRecords,
    blocks,
  })
  const structuredGather = new StructuredGatherSkill({
    blocks,
    vitals,
    inventory,
    excavate: excavateSkill,
  })
  const flattenArea = new FlattenAreaSkill({
    blocks,
    entities,
    vitals,
    inventory,
    executor: planExecutor,
    markers: new MarkerFinder(blocks),
    fetcher: materialFetcher,
  })
  // Farming: build_farm lays out a field as a plan (an engine client, like excavate) and then plants it; tending it
  // afterwards (planting, harvesting) is plain skills, with no engine dependency, so they also work on a
  // player-built field.
  const farmLayouts = new FarmLayoutRegistry()
    .register(new CropFieldProvider())
    .register(new AnimalPenProvider())
  const plantCrops = new PlantCropsSkill({
    blocks,
    navigator,
    tiller,
    placer: constructionPlacer,
    farms: farmRegistry,
  })
  const harvestCrops = new HarvestCropsSkill({
    blocks,
    crops: cropAccess,
    navigator,
    digger: constructionDigger,
    placer: constructionPlacer,
    drops: dropCollector,
    inventory,
    farms: farmRegistry,
  })
  const plantTrees = new PlantTreesSkill({
    blocks,
    navigator,
    placer: constructionPlacer,
    inventory,
    farms: farmRegistry,
    finder: new GroveSpotFinder({ blocks, guard: protectedAreas, farms: farmRegistry }),
    protectedAreas,
  })
  const harvestTrees = new HarvestTreesSkill({
    blocks,
    navigator,
    digger: constructionDigger,
    placer: constructionPlacer,
    drops: dropCollector,
    inventory,
    guard: protectedAreas,
    farms: farmRegistry,
  })
  const buildFarmSkill = new BuildFarmSkill({
    registry: farmLayouts,
    executor: planExecutor,
    vitals,
    farms: farmRegistry,
    protectedAreas,
    blocks,
    fetcher: materialFetcher,
    plant: plantCrops,
  })
  // Railways: the route and its plan are pure reading of the world; the shared plan executor lays them.
  const buildRailway = new BuildRailwaySkill({
    planner: new RailRoutePlanner({ blocks, guard: protectedAreas }),
    blocks,
    executor: planExecutor,
    vitals,
    entities,
    verifier: new RailVerifier({
      rails: new MineflayerRailAccess(connection),
      blocks,
      navigator,
      digger: constructionDigger,
      placer: constructionPlacer,
      scheduler,
    }),
    log: railwayLog,
    fetcher: materialFetcher,
  })
  const placeMinecart = new PlaceMinecartSkill({
    blocks,
    navigator,
    minecarts: new MineflayerMinecarts(connection),
    log: railwayLog,
  })
  const bucketFiller = new MineflayerBucketFiller(connection)
  const fillBucket = new FillBucketSkill({
    vitals,
    blocks,
    liquids: bucketFiller,
    filler: bucketFiller,
    inventory,
    navigator,
    guard: protectedAreas,
    spots: new LiquidSpotFinder(blocks),
  })
  const breakBlock = new BreakBlockSkill({
    vitals,
    blocks,
    digger: constructionDigger,
    navigator,
    inventory,
    guard: protectedAreas,
    hazards: new HazardRule(blocks),
    spots: new StandingSpotChooser(blocks),
    drops: dropCollector,
  })
  const smeltItems = new SmeltItemsSkill({
    inventory,
    furnaces: new MineflayerFurnaceAccess(connection),
    workstations,
    crafter: craftItem,
    clock,
    scheduler,
  })

  // Hunting.
  const animals = new MineflayerAnimalScanner(connection)
  const pens = new PenDetector(blocks)
  const huntAnimals = new HuntAnimalsSkill({
    animals,
    combatant,
    drops: dropCollector,
    inventory,
    smelter: smeltItems,
    pens,
    clock,
    full: inventoryFull,
    depositor: depositItems,
  })
  const attackEntity = new AttackEntitySkill({ animals, combatant, drops: dropCollector, clock })

  // Animal farming: pens (build_farm kind: pen), luring wild animals in, and breeding. Tending a pen's herd
  // (breeding up, culling down) is HerdManager, reused by tend_farm/inspect_farm above and TendFarmSkill's pen branch.
  const animalInteraction = new MineflayerAnimalInteraction(connection)
  const penGates = new PenGateGuard({ blocks, doors, navigator, logger })
  const lureAnimals = new LureAnimalsSkill({
    gates: penGates,
    animals,
    interaction: animalInteraction,
    navigator,
    vitals,
    farms: farmRegistry,
    scheduler,
  })
  const breedAnimals = new BreedAnimalsSkill({
    gates: penGates,
    animals,
    interaction: animalInteraction,
    navigator,
    clock,
    scheduler,
    farms: farmRegistry,
  })
  const herdManager = new HerdManager({ animals, breed: breedAnimals, hunt: huntAnimals })
  const eggThrower = new EggThrower({
    gaze: new MineflayerGaze(connection),
    writer: new MineflayerInventoryWriter(connection),
    scheduler,
  })
  const collectEggs = new CollectEggsSkill({
    gates: penGates,
    drops: dropCollector,
    inventory,
    vitals,
    animals,
    guard: protectedAreas,
    depositor: depositItems,
    thrower: eggThrower,
    policy: eggPolicy,
    farms: farmRegistry,
  })
  const tendFarm = new TendFarmSkill({
    farms: farmRegistry,
    harvest: harvestCrops,
    plant: plantCrops,
    herd: herdManager,
    collectEggs,
    plantTrees,
    gates: penGates,
  })
  const discoverFarm = new DiscoverFarmSkill({ blocks, crops: cropAccess, animals, farms: farmRegistry, vitals })
  const inspectFarm = new InspectFarmSkill({ blocks, crops: cropAccess, animals, farms: farmRegistry })
  // Server commands (teleporting), which only work when the server lets the bot use them.
  const serverCommands = new MineflayerServerCommands(connection, scheduler)
  const teleport = new TeleportSkill({
    commands: serverCommands,
    vitals,
    navigator,
    entities,
    spots: safeSpots,
    scheduler,
    botName: () => connection.target?.username,
  })
  const exploreForStructure = new ExploreForStructureSkill({
    navigator,
    vitals,
    blocks,
    biomes: new MineflayerBiomeReader(connection),
    entities,
    scanner: new StructureScanner(blocks, entities, defaultSignatures()),
    knowledge,
    clock,
    random,
    commands: serverCommands,
  })
  const launcher = new TaskLauncher(tasks, clock, reflexes)
  const invoke: ToolInvoker = (name, args, context) => registry.call(name, args, context)
  const registry = new ToolRegistry(logger, {
    onCall: (call) => {
      const line = describeToolCall(call)
      if (line !== undefined) history.record('tool', line)
    },
  })
    .register(new ConnectTool(session, briefing))
    .register(new DisconnectTool(connection))
    .register(
      new GetStatusTool(
        connection,
        vitals,
        inbox,
        {
          enabled: config.reflexesEnabled,
          activeReflex: () => reflexes.activeReflex(),
        },
        serverCommands,
      ),
    )
    .register(new WaitForChatTool(connection, inbox))
    .register(new SayTool(chat))
    .register(new WhisperTool(chat))
    .register(new LookAroundTool(new SurroundingsDescriber(blocks, entities, vitals)))
    .register(new FindBlocksTool(blockFinder))
    .register(new GetNearbyEntitiesTool(entities, vitals))
    .register(new GetPlayerPositionTool(entities, config.owner))
    .register(new GetInventoryTool(inventory))
    .register(new GoToTool(new GoToSkill(navigator, blockFinder), launcher))
    .register(new FollowPlayerTool(new FollowPlayerSkill(navigator), launcher, config.owner))
    .register(new PressSwitchTool(pressSwitch, launcher, lookTarget, config.owner))
    .register(new OpenDoorTool(openDoor, launcher, lookTarget, config.owner))
    .register(new FindSwitchesTool(switchFinder, lookTarget, config.owner))
    .register(new SetSwitchPolicyTool(switchPolicy, standing))
    .register(new SleepTool(sleepSkill, launcher))
    .register(new SetRespawnPointTool(setRespawnPoint, launcher))
    .register(new PlaceBedTool(placeBed, launcher))
    .register(
      new PlaceSignTool(placeSign, launcher, lookTarget, containerIndex, entities, config.owner),
    )
    .register(new EditSignTool(editSign, launcher, signTargeter, config.owner))
    .register(new RemoveSignTool(removeSign, launcher, signTargeter, config.owner))
    .register(new ReadSignsTool(signReader))
    .register(new ListBedsTool(bedRegistry))
    .register(new SetSleepPolicyTool(sleepPolicy, standing))
    .register(new CollectBlockTool(collectBlocks, structuredGather, launcher, collectSaplings))
    .register(new PickupItemsTool(new PickupItemsSkill(dropCollector, inventory), launcher))
    .register(new CraftTool(craftItem, launcher))
    .register(new SmeltTool(smeltItems, launcher))
    .register(new ListRecipesTool(recipes, planner, inventory))
    .register(new HuntAnimalsTool(huntAnimals, launcher))
    .register(new ListHuntableAnimalsTool(animals, pens))
    .register(new AttackEntityTool(attackEntity, launcher))
    .register(new SetFoodPolicyTool(foodPolicy, standing))
    .register(
      new RegisterContainerTool(
        containerIndex,
        storageRules,
        blocks,
        lookTarget,
        config.owner,
      ),
    )
    .register(new LabelContainerTool(containerIndex, storageRules))
    .register(new RemoveContainerTool(containerIndex, storageRules))
    .register(new ListContainersTool(containerIndex, storageRules))
    .register(new ScanContainersTool(scanContainers, launcher))
    .register(new SetStorageRuleTool(containerIndex, storageRules, itemFacts))
    .register(new ListStorageRulesTool(containerIndex, storageRules))
    .register(new RemoveStorageRuleTool(storageRules))
    .register(new DepositItemsTool(depositItems, launcher))
    .register(new WithdrawItemsTool(withdrawItems, launcher))
    .register(new FindItemsTool(findItems, launcher))
    .register(new SetStoragePolicyTool(storagePolicy, standing))
    .register(new ResumeTaskTool(tasks, clock))
    .register(new GiveItemsTool(giveItems, launcher, config.owner))
    .register(new DropItemsTool(dropItems, launcher))
    .register(new ResolveItemTool(new ItemResolver(itemFacts), inventory, containerIndex))
    .register(new BuildTool(buildSkill, launcher))
    .register(new PreviewBuildTool(buildSkill))
    .register(new ListBlueprintsTool(blueprints))
    .register(new PlaceBlockTool(buildSkill, launcher))
    .register(new ExcavateTool(excavateSkill, launcher, wallTarget, config.owner))
    .register(new PreviewExcavationTool(excavateSkill, wallTarget, config.owner))
    .register(new ListExcavationsTool(excavations, excavationRecords))
    .register(new FlattenAreaTool(flattenArea, launcher, config.owner))
    .register(new PreviewFlattenTool(flattenArea, config.owner))
    .register(new BuildFarmTool(buildFarmSkill, launcher))
    .register(new PlantCropsTool(plantCrops, launcher))
    .register(new HarvestCropsTool(harvestCrops, launcher))
    .register(new PlantTreesTool(plantTrees, launcher))
    .register(new CollectSaplingsTool(collectSaplings, launcher))
    .register(new HarvestTreesTool(harvestTrees, launcher))
    .register(new LureAnimalsTool(lureAnimals, launcher))
    .register(new BreedAnimalsTool(breedAnimals, launcher))
    .register(new CollectEggsTool(collectEggs, launcher))
    .register(new SetEggPolicyTool(eggPolicy, standing))
    .register(new TendFarmTool(tendFarm, launcher))
    .register(new InspectFarmTool(inspectFarm))
    .register(new DiscoverFarmTool(discoverFarm))
    .register(new ListFarmsTool(farmRegistry))
    .register(new RegisterFarmTool(farmRegistry))
    .register(new PlanRailwayTool(buildRailway))
    .register(new BuildRailwayTool(buildRailway, launcher))
    .register(new PlaceMinecartTool(placeMinecart, launcher))
    .register(new FillBucketTool(fillBucket, launcher))
    .register(new BreakBlockTool(breakBlock, launcher, lookTarget, config.owner))
    .register(new TeleportToPlayerTool(teleport, launcher, config.owner))
    .register(new TeleportToPositionTool(teleport, launcher))
    .register(new RecoverDropsTool(recoverDrops, launcher, dropRecords))
    .register(new SkipDropRecoveryTool(dropRecords, tasks, clock))
    .register(new SetDropRecoveryPolicyTool(dropPolicy, standing))
    .register(new ListDeathRecordsTool(dropRecords, clock))
    .register(new ProtectAreaTool(protectedAreas))
    .register(new UnprotectAreaTool(protectedAreas))
    .register(new ListProtectedAreasTool(protectedAreas))
    .register(new ExploreForStructureTool(exploreForStructure, launcher))
    .register(new ListKnownStructuresTool(knowledge, vitals))
    .register(new SetLandmarkTool(knowledge, vitals))
    .register(new ListLandmarksTool(knowledge))
    .register(new RemoveLandmarkTool(knowledge))
    .register(new GetTaskStatusTool(tasks, clock))
    .register(new CancelTaskTool(tasks, clock))
    .register(new StopTool(tasks, clock))
    .register(new GetSessionBriefingTool(briefing))
    .register(new ListWorldsTool(worldState))
    .register(new SetWorldProfileTool(session, briefing))
    .register(new ResumeInterruptedTaskTool(journal, invoke))
    .register(new DiscardInterruptedTaskTool(journal))
    .register(new GetRecentHistoryTool(history))
    .register(new RememberTool(notes))
    .register(new RecallTool(notes))
    .register(new ForgetTool(notes))
    .register(new SetStandingInstructionTool(standing))
    .register(new RemoveStandingInstructionTool(standing))
  const mcpServer = createMcpServer(registry)

  return {
    config,
    logger,
    clock,
    random,
    connection,
    inbox,
    session,
    tasks,
    worldState,
    reflexes,
    registry,
    mcpServer,
    serve: (transport) => mcpServer.connect(transport),
    shutdown: async () => {
      nightWatch.stop()
      await reflexes.stop()
      await tasks.cancel(undefined, 'shutdown')
      await connection.disconnect()
      await worldState.close()
      await mcpServer.close()
    },
  }
}
