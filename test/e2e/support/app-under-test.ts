import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createApp, type App } from '../../../src/app.js'
import type { Config } from '../../../src/config/config.types.js'
import { buildConfig } from '../../fakes/test-config.js'
import type { ServerInfo } from './server-config.js'

export interface ToolCallResult {
  readonly isError: boolean
  readonly text: string
  /** The reply parsed as JSON when the call succeeded. */
  readonly data: unknown
}

/** The parsed reply of a successful tool call. A failed call throws with the tool's own error text. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller states the expected shape of the reply
export function dataOf<T = Record<string, unknown>>(result: ToolCallResult): T {
  if (result.isError) throw new Error(`The tool call failed: ${result.text}`)
  return result.data as T
}

export interface AppUnderTest {
  readonly app: App
  readonly username: string
  /** Where this app saves its state. Reuse it to simulate restarting the server. */
  readonly dataDir: string
  call(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>
  shutdown(): Promise<void>
}

export interface StartAppOptions {
  /** In-game name of the bot. Use a unique one per test: the server may keep a stale session for a moment. */
  readonly username: string
  /** The player whose chat counts as instructions. */
  readonly owner: string
  /** Reuse a state directory (a restart). By default each app gets its own temporary one, removed on shutdown. */
  readonly dataDir?: string
  /** Settings that differ from the defaults, for example a shorter wait before unclaimed items are taken back. */
  readonly config?: Partial<Config>
}

/** The real app (real Mineflayer, real pathfinder) pointed at the e2e server, with a real MCP client in front. */
export async function startApp(info: ServerInfo, options: StartAppOptions): Promise<AppUnderTest> {
  const ownsDataDir = options.dataDir === undefined
  const dataDir = options.dataDir ?? mkdtempSync(path.join(tmpdir(), 'minecraft-mcp-e2e-'))
  const app = createApp(
    buildConfig({
      host: info.host,
      port: info.minecraftPort,
      version: info.version,
      username: options.username,
      owner: options.owner,
      dataDir,
      logLevel: 'warn',
      ...options.config,
    }),
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await app.serve(serverTransport)
  const client = new Client({ name: 'e2e-client', version: '1.0.0' })
  await client.connect(clientTransport)

  return {
    app,
    username: options.username,
    dataDir,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: 90_000,
      })
      const content = result.content as { type: string; text: string }[]
      const text = content.map((c) => c.text).join('\n')
      const isError = result.isError === true
      return { isError, text, data: isError ? undefined : (JSON.parse(text) as unknown) }
    },
    async shutdown() {
      await client.close()
      await app.shutdown()
      if (ownsDataDir) rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
