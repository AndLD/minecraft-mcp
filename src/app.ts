import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { AgentInbox } from './chat/agent-inbox.js'
import { ChatRouter } from './chat/chat-router.js'
import { StopCommand } from './chat/stop-command.js'
import type { BotFactory } from './bot/bot-like.types.js'
import { MineflayerBlockScanner } from './bot/mineflayer-block-scanner.js'
import { MineflayerChat } from './bot/mineflayer-chat.js'
import { MineflayerConnection } from './bot/mineflayer-connection.js'
import { createMineflayerBot } from './bot/mineflayer-bot-factory.js'
import { MineflayerEntityScanner } from './bot/mineflayer-entity-scanner.js'
import { MineflayerInventory } from './bot/mineflayer-inventory.js'
import { MineflayerNavigator } from './bot/mineflayer-navigator.js'
import { MineflayerVitals } from './bot/mineflayer-vitals.js'
import { createPathGoals } from './bot/path-goals.js'
import { MineflayerPathDriver, type GoalFactory } from './bot/path-driver.js'
import { UdpLanDiscovery } from './bot/udp-lan-discovery.js'
import type { Config } from './config/config.types.js'
import type { Clock } from './core/clock.port.js'
import type { Connection } from './core/connection.port.js'
import type { DatagramSocketFactory } from './core/datagram-socket.port.js'
import type { Logger } from './core/logger.js'
import type { Random } from './core/random.port.js'
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
import { FindBlocksTool } from './mcp/tools/find-blocks-tool.js'
import { FollowPlayerTool } from './mcp/tools/follow-player-tool.js'
import { GetInventoryTool } from './mcp/tools/get-inventory-tool.js'
import { GetNearbyEntitiesTool } from './mcp/tools/get-nearby-entities-tool.js'
import { GetPlayerPositionTool } from './mcp/tools/get-player-position-tool.js'
import { GetStatusTool } from './mcp/tools/get-status-tool.js'
import { GoToTool } from './mcp/tools/goto-tool.js'
import { LookAroundTool } from './mcp/tools/look-around-tool.js'
import { SayTool } from './mcp/tools/say-tool.js'
import { CancelTaskTool, GetTaskStatusTool, StopTool } from './mcp/tools/task-tools.js'
import { WaitForChatTool } from './mcp/tools/wait-for-chat-tool.js'
import { WhisperTool } from './mcp/tools/whisper-tool.js'
import { BlockFinder } from './perception/block-finder.js'
import { SurroundingsDescriber } from './perception/surroundings.js'
import { SessionService } from './session/session-service.js'
import { FollowPlayerSkill } from './skills/movement/follow-player-skill.js'
import { GoToSkill } from './skills/movement/goto-skill.js'
import { TaskManager } from './tasks/task-manager.js'

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

  const connection = new MineflayerConnection({ factory: botFactory, scheduler, logger })
  const chat = new MineflayerChat(connection)
  const vitals = new MineflayerVitals(connection)
  const blocks = new MineflayerBlockScanner(connection)
  const entities = new MineflayerEntityScanner(connection)
  const inventory = new MineflayerInventory(connection)
  const navigator = new MineflayerNavigator({
    holder: connection,
    driver: new MineflayerPathDriver(connection, pathGoals),
    entities,
    clock,
    scheduler,
  })
  const tasks = new TaskManager({ clock, scheduler, logger })
  const stopHandler = overrides.stopHandler ?? tasks
  const lanDiscovery = new UdpLanDiscovery(socketFactory, scheduler)

  const inbox = new AgentInbox({ clock, scheduler })
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
    if (event.type === 'disconnected' || event.type === 'kicked') tasks.stopAll()
    switch (event.type) {
      case 'connected':
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

  const session = new SessionService({ config, connection, lanDiscovery, logger })
  const blockFinder = new BlockFinder(blocks)
  const launcher = new TaskLauncher(tasks, clock)
  const registry = new ToolRegistry(logger)
    .register(new ConnectTool(session))
    .register(new DisconnectTool(connection))
    .register(new GetStatusTool(connection, vitals, inbox))
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
    .register(new GetTaskStatusTool(tasks, clock))
    .register(new CancelTaskTool(tasks, clock))
    .register(new StopTool(tasks, clock))
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
    registry,
    mcpServer,
    serve: (transport) => mcpServer.connect(transport),
    shutdown: async () => {
      await tasks.cancel()
      await connection.disconnect()
      await mcpServer.close()
    },
  }
}
