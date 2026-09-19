import type { LogLevel } from '../core/logger.js'

export interface Config {
  readonly host: string
  /** When undefined, the port is discovered from the LAN world broadcast. */
  readonly port: number | undefined
  readonly version: string
  readonly username: string
  readonly auth: 'offline' | 'microsoft'
  /** In-game name of the player whose chat counts as instructions. */
  readonly owner: string | undefined
  readonly autoConnect: boolean
  readonly dataDir: string
  /** Fallback world profile name, used when the world cannot be identified automatically. */
  readonly worldProfile: string | undefined
  readonly lowHealthThreshold: number
  /** Survival reflexes (eat, fight, flee, avoid lava, surface for air) run by themselves. */
  readonly reflexesEnabled: boolean
  readonly logLevel: LogLevel
}
