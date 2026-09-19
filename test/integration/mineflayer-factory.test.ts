import { createServer } from 'node:net'
import { describe, expect, it } from '@jest/globals'
import { createMineflayerBot } from '../../src/bot/mineflayer-bot-factory.js'
import { MineflayerConnection } from '../../src/bot/mineflayer-connection.js'
import { FakeLogger } from '../fakes/fake-logger.js'
import { SystemScheduler } from '../../src/infra/system-scheduler.js'

/** A TCP port nothing listens on: bind to a free port, then release it. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => {
        resolve(port)
      })
    })
  })
}

describe('the real Mineflayer factory (no Minecraft server needed)', () => {
  it('creates a real bot that reports a refused connection through the connection adapter', async () => {
    const port = await closedPort()
    const connection = new MineflayerConnection({
      factory: createMineflayerBot,
      scheduler: new SystemScheduler(),
      logger: new FakeLogger(),
      connectTimeoutMs: 10_000,
    })

    const result = await connection.connect({
      host: '127.0.0.1',
      port,
      username: 'TestBot',
      version: '1.21.1',
      auth: 'offline',
    })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain('ECONNREFUSED')
    expect(connection.state).toBe('disconnected')
  })
})
