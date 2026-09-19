import type { Config } from '../config/config.types.js'
import type { Connection, ConnectTarget } from '../core/connection.port.js'
import type { LanDiscovery } from '../core/lan-discovery.port.js'
import type { Logger } from '../core/logger.js'
import { err, ok, type Result } from '../core/result.js'
import type { WorldFingerprint, WorldIdentifier } from '../core/world-identifier.port.js'
import type { WorldOpenResult, WorldStateManager } from '../state/world-state-manager.js'

export interface ConnectRequest {
  readonly host?: string | undefined
  readonly port?: number | undefined
  /** A name for the world, used only when it cannot be recognized automatically. */
  readonly profile?: string | undefined
}

export interface ConnectedSession {
  readonly username: string
  readonly version: string
  readonly host: string
  readonly port: number
  /** Set when the port was discovered from the LAN announcement. */
  readonly worldName: string | undefined
  /** How the world was identified and which saved state is active. */
  readonly world: WorldOpenResult
}

export interface SessionServiceOptions {
  readonly config: Config
  readonly connection: Connection
  readonly lanDiscovery: LanDiscovery
  readonly logger: Logger
  readonly identifier: WorldIdentifier
  readonly worldState: WorldStateManager
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
  private readonly identifier: WorldIdentifier
  private readonly worldState: WorldStateManager
  private readonly discoveryTimeoutMs: number

  constructor(options: SessionServiceOptions) {
    this.config = options.config
    this.connection = options.connection
    this.lanDiscovery = options.lanDiscovery
    this.logger = options.logger
    this.identifier = options.identifier
    this.worldState = options.worldState
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
    const world = await this.openWorld(
      target,
      worldName,
      request.profile ?? this.config.worldProfile,
    )
    return ok({
      username: result.value.username,
      version: result.value.version,
      host,
      port,
      worldName,
      world,
    })
  }

  /** Binds the connected world to a profile name (when identification needed help, or to rename). */
  async nameWorld(name: string): Promise<Result<WorldOpenResult>> {
    const target = this.connection.target
    if (this.connection.state !== 'connected' || target === undefined) {
      return err('Not connected to a Minecraft world. Call connect first.')
    }
    const fingerprint = await this.fingerprintOf(target, undefined)
    const opened = await this.worldState.bind(name, fingerprint)
    return opened.resolution.kind === 'invalid_name'
      ? err(`"${name}" is not a usable profile name: use letters or digits.`)
      : ok(opened)
  }

  /** Recognizes the world automatically; a given name is only the fallback when that fails. */
  private async openWorld(
    target: ConnectTarget,
    worldNameHint: string | undefined,
    fallbackName: string | undefined,
  ): Promise<WorldOpenResult> {
    const fingerprint = await this.fingerprintOf(target, worldNameHint)
    const opened = await this.worldState.open(fingerprint)
    const unresolved =
      opened.resolution.kind === 'needs_name' || opened.resolution.kind === 'ambiguous'
    return unresolved && fallbackName !== undefined
      ? this.worldState.bind(fallbackName, fingerprint)
      : opened
  }

  private async fingerprintOf(
    target: ConnectTarget,
    worldNameHint: string | undefined,
  ): Promise<WorldFingerprint> {
    try {
      return await this.identifier.identify(target, worldNameHint)
    } catch (error) {
      this.logger.warn('Could not identify the world', { error })
      return { seed: null, worldName: worldNameHint ?? null, spawn: null }
    }
  }
}
