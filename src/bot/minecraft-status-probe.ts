import mc from 'minecraft-protocol'
import type { ServerStatus, ServerStatusProbe } from '../core/server-status.port.js'
import { flattenMotd } from './motd.js'

export interface PingOptions {
  readonly host: string
  readonly port: number
  readonly closeTimeout: number
}

/** The status ping, replaceable in tests. */
export type PingFunction = (
  options: PingOptions,
) => Promise<{ readonly description?: unknown; readonly motd?: unknown }>

const realPing: PingFunction = (options) => mc.ping(options)

const PROBE_TIMEOUT_MS = 3_000

/** Reads a server's message of the day with the Minecraft status ping. */
export class MinecraftServerStatusProbe implements ServerStatusProbe {
  constructor(private readonly ping: PingFunction = realPing) {}

  async probe(host: string, port: number): Promise<ServerStatus | undefined> {
    try {
      const status = await this.ping({ host, port, closeTimeout: PROBE_TIMEOUT_MS })
      const motd = flattenMotd(status.description ?? status.motd)
      return motd === '' ? undefined : { motd }
    } catch {
      return undefined
    }
  }
}
