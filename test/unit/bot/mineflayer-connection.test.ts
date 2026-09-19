import { describe, expect, it } from '@jest/globals'
import type { BotLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerConnection } from '../../../src/bot/mineflayer-connection.js'
import type { ConnectionEvent, ConnectTarget } from '../../../src/core/connection.port.js'
import { FakeBot } from '../../fakes/fake-bot.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { FakeLogger } from '../../fakes/fake-logger.js'
import { FakeScheduler } from '../../fakes/fake-scheduler.js'

const target: ConnectTarget = {
  host: 'localhost',
  port: 34231,
  username: 'ClaudeBot',
  version: '1.21.1',
  auth: 'offline',
}

function setup(options: { throwOnCreate?: boolean } = {}) {
  const scheduler = new FakeScheduler(new FakeClock())
  const bot = new FakeBot()
  const created: ConnectTarget[] = []
  const connection = new MineflayerConnection({
    factory: (t) => {
      created.push(t)
      if (options.throwOnCreate === true) throw new Error('no such version')
      return bot
    },
    scheduler,
    logger: new FakeLogger(),
    connectTimeoutMs: 10_000,
  })
  const events: ConnectionEvent[] = []
  connection.onEvent((e) => events.push(e))
  const bots: (BotLike | undefined)[] = []
  connection.onChange((b) => bots.push(b))
  return { connection, bot, scheduler, created, events, bots }
}

describe('MineflayerConnection', () => {
  describe('connect', () => {
    it('starts disconnected with no target and no bot', () => {
      const { connection } = setup()
      expect(connection.state).toBe('disconnected')
      expect(connection.target).toBeUndefined()
      expect(connection.current()).toBeUndefined()
    })

    it('connects when the bot spawns and reports the session', async () => {
      const { connection, bot, events, bots, created } = setup()

      const pending = connection.connect(target)
      expect(connection.state).toBe('connecting')
      expect(connection.current()).toBeUndefined()
      bot.emit('spawn')
      const result = await pending

      expect(result).toEqual({ ok: true, value: { username: 'ClaudeBot', version: '1.21.1' } })
      expect(connection.state).toBe('connected')
      expect(connection.target).toBe(target)
      expect(connection.current()).toBe(bot)
      expect(created).toEqual([target])
      expect(events).toEqual([{ type: 'connected', username: 'ClaudeBot' }])
      expect(bots).toEqual([bot])
    })

    it('refuses a second connect while connecting or connected', async () => {
      const { connection, bot } = setup()
      const first = connection.connect(target)

      const whileConnecting = await connection.connect(target)
      bot.emit('spawn')
      await first
      const whileConnected = await connection.connect(target)

      expect(whileConnecting).toEqual({
        ok: false,
        error: 'Cannot connect while connecting. Disconnect first.',
      })
      expect(whileConnected).toEqual({
        ok: false,
        error: 'Cannot connect while connected. Disconnect first.',
      })
    })

    it('fails when the bot cannot be created', async () => {
      const { connection } = setup({ throwOnCreate: true })

      const result = await connection.connect(target)

      expect(result).toEqual({ ok: false, error: 'Could not create the bot: no such version' })
      expect(connection.state).toBe('disconnected')
    })

    it('fails on a connection error and allows a retry', async () => {
      const { connection, bot, events } = setup()
      const pending = connection.connect(target)

      bot.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:34231'))
      const result = await pending

      expect(result).toEqual({
        ok: false,
        error: 'Connection error: connect ECONNREFUSED 127.0.0.1:34231',
      })
      expect(connection.state).toBe('disconnected')
      expect(connection.current()).toBeUndefined()
      expect(events).toEqual([])
      expect(bot.quitCalls).toBe(1)
      expect(bot.listenerCount('spawn')).toBe(0)
    })

    it('fails when kicked while joining', async () => {
      const { connection, bot } = setup()
      const pending = connection.connect(target)

      bot.emit('kicked', { text: 'Outdated client' })

      expect(await pending).toEqual({
        ok: false,
        error: 'Kicked while joining: {"text":"Outdated client"}',
      })
    })

    it('fails when the connection closes before joining', async () => {
      const { connection, bot } = setup()
      const pending = connection.connect(target)

      bot.emit('end', 'socketClosed')

      expect(await pending).toEqual({
        ok: false,
        error: 'Connection closed before joining: socketClosed',
      })
    })

    it('times out when the bot never spawns', async () => {
      const { connection, scheduler } = setup()
      const pending = connection.connect(target)

      scheduler.advance(10_000)
      const result = await pending

      expect(result).toEqual({
        ok: false,
        error: 'Timed out after 10 s waiting to join localhost:34231',
      })
      expect(connection.state).toBe('disconnected')
    })

    it('ignores a quit() that throws while cleaning up a failed connect', async () => {
      const { connection, bot } = setup()
      bot.quit = () => {
        throw new Error('already closed')
      }
      const pending = connection.connect(target)

      bot.emit('error', new Error('boom'))

      expect((await pending).ok).toBe(false)
    })

    it('does not settle twice when several failures arrive', async () => {
      const { connection, bot, scheduler } = setup()
      const pending = connection.connect(target)

      bot.emit('error', new Error('first'))
      scheduler.advance(10_000)

      expect(await pending).toEqual({ ok: false, error: 'Connection error: first' })
    })
  })

  describe('while connected', () => {
    async function connected() {
      const context = setup()
      const pending = context.connection.connect(target)
      context.bot.emit('spawn')
      await pending
      context.events.length = 0
      return context
    }

    it('reports an unexpected disconnect and forgets the bot', async () => {
      const { connection, bot, events, bots } = await connected()

      bot.emit('end', 'socketClosed')

      expect(connection.state).toBe('disconnected')
      expect(connection.current()).toBeUndefined()
      expect(events).toEqual([{ type: 'disconnected', reason: 'socketClosed' }])
      expect(bots.at(-1)).toBeUndefined()
    })

    it('reports being kicked', async () => {
      const { bot, events } = await connected()

      bot.emit('kicked', 'You were kicked')

      expect(events).toEqual([{ type: 'kicked', reason: 'You were kicked' }])
    })

    it('reports runtime errors without disconnecting', async () => {
      const { connection, bot, events } = await connected()

      bot.emit('error', new Error('packet problem'))

      expect(events).toEqual([{ type: 'error', message: 'packet problem' }])
      expect(connection.state).toBe('connected')
    })

    it('allows reconnecting after a disconnect', async () => {
      const { connection, bot } = await connected()
      bot.emit('end', 'socketClosed')

      const again = connection.connect(target)
      bot.emit('spawn')

      expect((await again).ok).toBe(true)
    })
  })

  describe('disconnect', () => {
    it('does nothing when not connected', async () => {
      const { connection, bot } = setup()

      await connection.disconnect()

      expect(bot.quitCalls).toBe(0)
    })

    it('quits the bot and reports a requested disconnect', async () => {
      const { connection, bot, events } = setup()
      const pending = connection.connect(target)
      bot.emit('spawn')
      await pending
      events.length = 0

      await connection.disconnect()

      expect(bot.quitCalls).toBe(1)
      expect(connection.state).toBe('disconnected')
      expect(events).toEqual([{ type: 'disconnected', reason: 'Disconnected by request' }])
    })

    it('gives up waiting for the bot to end after a few seconds', async () => {
      const { connection, bot, scheduler, events } = setup()
      bot.endOnQuit = false
      const pending = connection.connect(target)
      bot.emit('spawn')
      await pending
      events.length = 0

      const done = connection.disconnect()
      scheduler.advance(3_000)
      await done

      expect(connection.state).toBe('disconnected')
      expect(events).toEqual([{ type: 'disconnected', reason: 'Disconnected by request' }])
    })
  })

  it('stops notifying unsubscribed listeners', async () => {
    const { connection, bot } = setup()
    const seen: string[] = []
    const stopEvents = connection.onEvent((e) => seen.push(e.type))
    const stopBots = connection.onChange(() => seen.push('bot'))
    stopEvents()
    stopBots()

    const pending = connection.connect(target)
    bot.emit('spawn')
    await pending

    expect(seen).toEqual([])
  })
})
