export interface LanWorld {
  readonly port: number
  readonly worldName: string
  /** The player who opened the world to LAN, when the announcement says so. */
  readonly hostPlayer: string | undefined
}

export interface LanDiscoveryOptions {
  readonly timeoutMs: number
  /** Stop early when a world hosted by this player is announced; otherwise the first one seen wins at the timeout. */
  readonly preferHostPlayer?: string
}

export interface LanDiscovery {
  /** Listens to the LAN world announcements. Undefined when none was heard in time. */
  discover(options: LanDiscoveryOptions): Promise<LanWorld | undefined>
}
