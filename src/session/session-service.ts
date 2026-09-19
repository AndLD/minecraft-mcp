import type { Config } from '../config/config.types.js'
import type { Connection, ConnectTarget } from '../core/connection.port.js'
import type { LanDiscovery } from '../core/lan-discovery.port.js'
import type { Logger } from '../core/logger.js'
import { err, ok, type Result } from '../core/result.js'

export interface ConnectRequest {
  readonly host?: string | undefined
  readonly port?: number | undefined
}

export interface ConnectedSession {
  readonly username: string
  readonly version: string
  readonly host: string
  readonly port: number
  /** Set when the port was discovered from the LAN announcement. */
  readonly worldName: string | undefined
}

export interface SessionServiceOptions {
  readonly config: Config
  readonly connection: Connection
  readonly lanDiscovery: LanDiscovery
  readonly logger: Logger
  /** How long to listen for a LAN announcement when no port is known. */
  readonly discoveryTimeoutMs?: number
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 4_000

/** Works out where to connect (request, then config, then LAN discovery) and connects. */
export class SessionService {
  private readonly config: Config
  private readonly connection: Connection
  private readonly lanDiscovery: LanDiscovery
  private readonly logger: Logger
  private readonly discoveryTimeoutMs: number

  constructor(options: SessionServiceOptions) {
    this.config = options.config
    this.connection = options.connection
    this.lanDiscovery = options.lanDiscovery
    this.logger = options.logger
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS
  }

  async connect(request: ConnectRequest = {}): Promise<Result<ConnectedSession>> {
    if (this.connection.state !== 'disconnected') {
      return err(`Already ${this.connection.state}. Call disconnect first to reconnect elsewhere.`)
    }
    const host = request.host ?? this.config.host
    let port = request.port ?? this.config.port
    let worldName: string | undefined

    if (port === undefined) {
      this.logger.info('No port given; listening for a LAN world announcement')
      const world = await this.lanDiscovery.discover({
        timeoutMs: this.discoveryTimeoutMs,
        ...(this.config.owner === undefined ? {} : { preferHostPlayer: this.config.owner }),
      })
      if (world === undefined) {
        return err(
          'No port given and no LAN world was announced. Open the world to LAN (Esc → Open to LAN), or pass the port explicitly.',
        )
      }
      port = world.port
      worldName = world.worldName
    }

    const target: ConnectTarget = {
      host,
      port,
      username: this.config.username,
      version: this.config.version,
      auth: this.config.auth,
    }
    this.logger.info('Connecting', { host, port })
    const result = await this.connection.connect(target)
    if (!result.ok) return result
    return ok({
      username: result.value.username,
      version: result.value.version,
      host,
      port,
      worldName,
    })
  }
}
