import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { AgentInbox } from './chat/agent-inbox.js'
import { ChatRouter } from './chat/chat-router.js'
import { NoopStopHandler } from './chat/noop-stop-handler.js'
import { StopCommand } from './chat/stop-command.js'
import type { BotFactory } from './bot/bot-like.types.js'
import { MineflayerChat } from './bot/mineflayer-chat.js'
import { MineflayerConnection } from './bot/mineflayer-connection.js'
import { createMineflayerBot } from './bot/mineflayer-bot-factory.js'
import { MineflayerVitals } from './bot/mineflayer-vitals.js'
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
import { ToolRegistry } from './mcp/tool-registry.js'
import { ConnectTool } from './mcp/tools/connect-tool.js'
import { DisconnectTool } from './mcp/tools/disconnect-tool.js'
import { GetStatusTool } from './mcp/tools/get-status-tool.js'
import { SayTool } from './mcp/tools/say-tool.js'
import { WaitForChatTool } from './mcp/tools/wait-for-chat-tool.js'
import { WhisperTool } from './mcp/tools/whisper-tool.js'
import { SessionService } from './session/session-service.js'

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
  /** What "stop" cancels. Replaced by the task manager once tasks exist. */
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
  const stopHandler = overrides.stopHandler ?? new NoopStopHandler()

  const connection = new MineflayerConnection({ factory: botFactory, scheduler, logger })
  const chat = new MineflayerChat(connection)
  const vitals = new MineflayerVitals(connection)
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
  const registry = new ToolRegistry(logger)
    .register(new ConnectTool(session))
    .register(new DisconnectTool(connection))
    .register(new GetStatusTool(connection, vitals, inbox))
    .register(new WaitForChatTool(connection, inbox))
    .register(new SayTool(chat))
    .register(new WhisperTool(chat))
  const mcpServer = createMcpServer(registry)

  return {
    config,
    logger,
    clock,
    random,
    connection,
    inbox,
    session,
    registry,
    mcpServer,
    serve: (transport) => mcpServer.connect(transport),
    shutdown: async () => {
      await connection.disconnect()
      await mcpServer.close()
    },
  }
}
