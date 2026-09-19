import type { Config } from '../../src/config/config.types.js'

/** A valid config for tests, with optional overrides. */
export function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: 'localhost',
    port: 25565,
    version: '1.21.1',
    username: 'TestBot',
    auth: 'offline',
    owner: 'Tester',
    autoConnect: false,
    dataDir: './data',
    worldProfile: undefined,
    lowHealthThreshold: 8,
    logLevel: 'info',
    ...overrides,
  }
}
