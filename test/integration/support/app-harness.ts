import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createApp, type App } from '../../../src/app.js'
import type { Config } from '../../../src/config/config.types.js'
import { FakeBot } from '../../fakes/fake-bot.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { FakeLogger } from '../../fakes/fake-logger.js'
import { FakeScheduler } from '../../fakes/fake-scheduler.js'
import { FakeSocket } from '../../fakes/fake-socket.js'
import { buildConfig } from '../../fakes/test-config.js'

export interface ToolCallResult {
  readonly isError: boolean
  readonly text: string
  /** The text parsed as JSON when the call succeeded. */
  readonly data: unknown
}

export interface Harness {
  readonly app: App
  readonly client: Client
  readonly bot: FakeBot
  readonly socket: FakeSocket
  readonly clock: FakeClock
  readonly scheduler: FakeScheduler
  readonly logger: FakeLogger
  /** Targets the bot factory was asked to connect to. */
  readonly connectTargets: { host: string; port: number }[]
  readonly call: (name: string, args?: Record<string, unknown>) => Promise<ToolCallResult>
  /** Lets pending promises and in-memory transport messages settle. */
  readonly settle: () => Promise<void>
  readonly close: () => Promise<void>
}

/**
 * The real app wired over stub seams (fake bot, fake UDP socket, fake time),
 * with a real MCP client talking to the real MCP server over an in-memory transport.
 */
export interface HarnessOptions {
  /** When false the fake bot does not spawn by itself, so a test can fail the join. */
  readonly autoSpawn?: boolean
}

export async function createHarness(
  config: Partial<Config> = {},
  options: HarnessOptions = {},
): Promise<Harness> {
  const clock = new FakeClock(Date.UTC(2026, 8, 19, 12, 0, 0))
  const scheduler = new FakeScheduler(clock)
  const logger = new FakeLogger()
  const bot = new FakeBot()
  const socket = new FakeSocket()
  const connectTargets: { host: string; port: number }[] = []

  const app = createApp(buildConfig({ port: 34231, owner: 'Andrey_Knight', ...config }), {
    clock,
    scheduler,
    logger,
    botFactory: (target) => {
      connectTargets.push({ host: target.host, port: target.port })
      if (options.autoSpawn !== false) {
        queueMicrotask(() => {
          bot.emit('spawn')
        })
      }
      return bot
    },
    socketFactory: () => socket,
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await app.serve(serverTransport)
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))
  }

  return {
    app,
    client,
    bot,
    socket,
    clock,
    scheduler,
    logger,
    connectTargets,
    settle,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args })
      const content = result.content as { type: string; text: string }[]
      const text = content.map((c) => c.text).join('\n')
      const isError = result.isError === true
      return { isError, text, data: isError ? undefined : (JSON.parse(text) as unknown) }
    },
    async close() {
      await client.close()
      await app.shutdown()
    },
  }
}
