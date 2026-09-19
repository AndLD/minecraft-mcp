import { tmpdir } from 'node:os'
import path from 'node:path'
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
    // Never the repository's ./data: each test process writes its state under the OS temp directory.
    dataDir: path.join(tmpdir(), `minecraft-mcp-tests-${String(process.pid)}`),
    worldProfile: undefined,
    lowHealthThreshold: 8,
    reflexesEnabled: true,
    logLevel: 'info',
    ...overrides,
  }
}
