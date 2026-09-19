import { readFileSync } from 'node:fs'
import path from 'node:path'

/** Where the global setup (global-setup.mjs, which duplicates these paths) leaves the server details and its log. */
export const E2E_DIR = path.resolve('.e2e')
export const SERVER_INFO_PATH = path.join(E2E_DIR, 'server.json')
export const SERVER_LOG_PATH = path.join(E2E_DIR, 'server.log')

/** How to reach the running e2e server. */
export interface ServerInfo {
  readonly host: string
  readonly minecraftPort: number
  readonly rconPort: number
  readonly rconPassword: string
}

export function readServerInfo(): ServerInfo {
  try {
    return JSON.parse(readFileSync(SERVER_INFO_PATH, 'utf8')) as ServerInfo
  } catch {
    throw new Error(
      `The e2e server is not running (could not read ${SERVER_INFO_PATH}). Run e2e tests through "npm run test:e2e".`,
    )
  }
}
