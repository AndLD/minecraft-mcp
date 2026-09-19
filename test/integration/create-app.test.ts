import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config/env.js'
import type { StopHandler } from '../../src/core/stop-handler.port.js'
import { FakeBot } from '../fakes/fake-bot.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { FakeLogger } from '../fakes/fake-logger.js'
import { FakeRandom } from '../fakes/fake-random.js'
import { FakeScheduler } from '../fakes/fake-scheduler.js'
import { buildConfig } from '../fakes/test-config.js'

describe('createApp', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('wires the injected dependencies and the config', () => {
    const config = buildConfig()
    const logger = new FakeLogger()
    const clock = new FakeClock()
    const random = new FakeRandom()

    const app = createApp(config, { logger, clock, random, scheduler: new FakeScheduler(clock) })

    expect(app.config).toBe(config)
    expect(app.logger).toBe(logger)
    expect(app.clock).toBe(clock)
    expect(app.random).toBe(random)
  })

  it('registers all tools and builds real defaults from an environment config', () => {
    const parsed = loadConfig({ MC_OWNER: 'Andrey_Knight', LOG_LEVEL: 'debug' })
    if (!parsed.ok) throw new Error('config should be valid')

    const app = createApp(parsed.value)

    expect(app.registry.list()).toHaveLength(35)
    expect(app.clock.now()).toBeGreaterThan(0)
    expect(app.random.next()).toBeLessThan(1)
    expect(app.connection.state).toBe('disconnected')
  })

  it('has no side effects while being created and logs only to stderr', () => {
    const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)

    const app = createApp(buildConfig({ logLevel: 'info' }))
    expect(stderr).not.toHaveBeenCalled()

    app.logger.info('ready')
    app.logger.debug('below the configured level')

    expect(stderr).toHaveBeenCalledTimes(1)
    expect(stdout).not.toHaveBeenCalled()
  })

  it('honors the configured log level in the default logger', () => {
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)

    const app = createApp(buildConfig({ logLevel: 'error' }))
    app.logger.warn('ignored')
    app.logger.error('kept')

    expect(stderr).toHaveBeenCalledTimes(1)
  })

  it('cancels tasks through the injected stop handler when the owner says stop', async () => {
    const clock = new FakeClock()
    const bot = new FakeBot()
    const stopAll = jest.fn()
    const stopHandler: StopHandler = { stopAll }
    const app = createApp(buildConfig({ owner: 'Andrey_Knight' }), {
      clock,
      scheduler: new FakeScheduler(clock),
      logger: new FakeLogger(),
      stopHandler,
      botFactory: () => {
        queueMicrotask(() => {
          bot.emit('spawn')
        })
        return bot
      },
    })
    const connected = await app.session.connect()
    expect(connected.ok).toBe(true)

    bot.emit('chat', 'Andrey_Knight', 'stop')

    expect(stopAll).toHaveBeenCalledTimes(1)
    await app.shutdown()
  })
})
