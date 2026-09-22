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
import { MineflayerNavigator } from './bot/mineflayer-navigator.js'
import { MineflayerLightReader } from './bot/mineflayer-light-reader.js'
import { MineflayerPlacer } from './bot/mineflayer-placer.js'
import { MineflayerRecipes } from './bot/mineflayer-recipes.js'
import { MineflayerServerCommands } from './bot/mineflayer-server-commands.js'
import { MineflayerVitals } from './bot/mineflayer-vitals.js'
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
import { DropRecords } from './state/drop-records.js'
import { DropRecoveryPolicy } from './state/drop-recovery-policy.js'
import { FoodPolicy } from './state/food-policy.js'
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
import {
  BranchMineProvider,
  StaircaseDownProvider,
  TunnelProvider,
} from './skills/excavation/providers/tunnels.js'
import { FlattenAreaSkill } from './skills/site-leveling/flatten-area-skill.js'
import { MarkerFinder } from './skills/site-leveling/marker-finder.js'
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
import { FollowPlayerSkill } from './skills/movement/follow-player-skill.js'
import { GoToSkill } from './skills/movement/goto-skill.js'
import { TaskManager } from './tasks/task-manager.js'

/** A record tried this often is not tried again without the player's say-so. */
const DEFAULT_RECOVERY_ATTEMPTS = 2
/** When a task or reflex keeps the bot busy, an automatic recovery tries again this often, for about 3 minutes. */
const RECOVERY_RETRY_MS = 5_000
const RECOVERY_RETRIES = 36

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
  const navigator = new MineflayerNavigator({
    holder: connection,
    driver: paths,
    entities,
    clock,
    scheduler,
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
      containerIndex,
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
      // Cancel first, so the journal records the tasks as interrupted, then release the world's state.
      void tasks.cancel(undefined, 'disconnected').then(() => worldState.close())
    }
    switch (event.type) {
      case 'connected':
        if (config.reflexesEnabled) reflexes.start()
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
  const excavations = new ExcavationRegistry()
    .register(new PitProvider())
    .register(new ShaftProvider())
    .register(new QuarryProvider())
    .register(new TunnelProvider())
    .register(new BranchMineProvider())
    .register(new StaircaseDownProvider())
  const excavateSkill = new ExcavateSkill({
    registry: excavations,
    executor: planExecutor,
    vitals,
    fetcher: materialFetcher,
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
    .register(new CollectBlockTool(collectBlocks, structuredGather, launcher))
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
        new MineflayerLookTarget(connection),
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
    .register(new ExcavateTool(excavateSkill, launcher))
    .register(new PreviewExcavationTool(excavateSkill))
    .register(new ListExcavationsTool(excavations))
    .register(new FlattenAreaTool(flattenArea, launcher, config.owner))
    .register(new PreviewFlattenTool(flattenArea, config.owner))
    .register(new TeleportToPlayerTool(teleport, launcher, config.owner))
    .register(new TeleportToPositionTool(teleport, launcher))
    .register(new RecoverDropsTool(recoverDrops, launcher, dropRecords))
    .register(new SkipDropRecoveryTool(dropRecords, tasks, clock))
    .register(new SetDropRecoveryPolicyTool(dropPolicy, standing))
    .register(new ListDeathRecordsTool(dropRecords, clock))
    .register(new ProtectAreaTool(protectedAreas))
    .register(new UnprotectAreaTool(protectedAreas))
    .register(new ListProtectedAreasTool(protectedAreas))
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
      await reflexes.stop()
      await tasks.cancel(undefined, 'shutdown')
      await connection.disconnect()
      await worldState.close()
      await mcpServer.close()
    },
  }
}
