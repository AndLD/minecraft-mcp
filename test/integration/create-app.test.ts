import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config/env.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { FakeLogger } from '../fakes/fake-logger.js'
import { FakeRandom } from '../fakes/fake-random.js'
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

    const app = createApp(config, { logger, clock, random })

    expect(app.config).toBe(config)
    expect(app.logger).toBe(logger)
    expect(app.clock).toBe(clock)
    expect(app.random).toBe(random)
  })

  it('builds real defaults from a config parsed from the environment', () => {
    const parsed = loadConfig({ MC_OWNER: 'Andrey_Knight', LOG_LEVEL: 'debug' })
    if (!parsed.ok) throw new Error('config should be valid')

    const app = createApp(parsed.value)

    expect(app.config.owner).toBe('Andrey_Knight')
    expect(app.clock.now()).toBeGreaterThan(0)
    expect(app.random.next()).toBeLessThan(1)
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
})
