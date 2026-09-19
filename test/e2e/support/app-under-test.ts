import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createApp, type App } from '../../../src/app.js'
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
  call(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>
  shutdown(): Promise<void>
}

export interface StartAppOptions {
  /** In-game name of the bot. Use a unique one per test: the server may keep a stale session for a moment. */
  readonly username: string
  /** The player whose chat counts as instructions. */
  readonly owner: string
}

/** The real app (real Mineflayer, real pathfinder) pointed at the e2e server, with a real MCP client in front. */
export async function startApp(info: ServerInfo, options: StartAppOptions): Promise<AppUnderTest> {
  const app = createApp(
    buildConfig({
      host: info.host,
      port: info.minecraftPort,
      username: options.username,
      owner: options.owner,
      logLevel: 'warn',
    }),
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await app.serve(serverTransport)
  const client = new Client({ name: 'e2e-client', version: '1.0.0' })
  await client.connect(clientTransport)

  return {
    app,
    username: options.username,
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
    },
  }
}
