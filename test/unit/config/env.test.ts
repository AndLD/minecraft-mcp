import { describe, expect, it } from '@jest/globals'
import type { Config } from '../../../src/config/config.types.js'
import { loadConfig } from '../../../src/config/env.js'

function loadOk(env: Record<string, string | undefined>): Config {
  const result = loadConfig(env)
  if (!result.ok) throw new Error(`expected valid config, got: ${result.error.issues.join('; ')}`)
  return result.value
}

function loadIssues(env: Record<string, string | undefined>): readonly string[] {
  const result = loadConfig(env)
  if (result.ok) throw new Error('expected invalid config')
  return result.error.issues
}

describe('loadConfig', () => {
  it('applies defaults for an empty environment', () => {
    expect(loadOk({})).toEqual({
      host: 'localhost',
      port: undefined,
      version: '1.21.1',
      username: 'ClaudeBot',
      auth: 'offline',
      owner: undefined,
      autoConnect: false,
      dataDir: './data',
      worldProfile: undefined,
      lowHealthThreshold: 8,
      unclaimedDropWaitSeconds: 60,
      reflexesEnabled: true,
      logLevel: 'info',
    })
  })

  it('does not require MC_PORT (it is discovered from the LAN broadcast)', () => {
    expect(loadOk({}).port).toBeUndefined()
  })

  it('parses every provided value', () => {
    const config = loadOk({
      MC_HOST: '192.168.0.10',
      MC_PORT: '34231',
      MC_VERSION: '1.20.4',
      MC_USERNAME: 'Helper',
      MC_AUTH: 'microsoft',
      MC_OWNER: 'Andrey_Knight',
      MC_AUTO_CONNECT: 'true',
      DATA_DIR: '/var/mc',
      WORLD_PROFILE: 'survival1',
      LOW_HEALTH_THRESHOLD: '6',
      UNCLAIMED_DROP_WAIT_SECONDS: '20',
      REFLEXES_ENABLED: 'false',
      LOG_LEVEL: 'debug',
    })
    expect(config).toEqual({
      host: '192.168.0.10',
      port: 34231,
      version: '1.20.4',
      username: 'Helper',
      auth: 'microsoft',
      owner: 'Andrey_Knight',
      autoConnect: true,
      dataDir: '/var/mc',
      worldProfile: 'survival1',
      lowHealthThreshold: 6,
      unclaimedDropWaitSeconds: 20,
      reflexesEnabled: false,
      logLevel: 'debug',
    })
  })

  it('treats empty and whitespace-only values as not set', () => {
    const config = loadOk({ MC_PORT: '', MC_OWNER: '  ', WORLD_PROFILE: '', MC_HOST: '' })
    expect(config.port).toBeUndefined()
    expect(config.owner).toBeUndefined()
    expect(config.worldProfile).toBeUndefined()
    expect(config.host).toBe('localhost')
  })

  it('trims surrounding whitespace', () => {
    expect(loadOk({ MC_OWNER: ' Andrey_Knight ' }).owner).toBe('Andrey_Knight')
  })

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ])('parses MC_AUTO_CONNECT=%s', (raw, expected) => {
    expect(loadOk({ MC_AUTO_CONNECT: raw }).autoConnect).toBe(expected)
  })

  it('rejects an invalid boolean', () => {
    expect(loadIssues({ MC_AUTO_CONNECT: 'yes' })[0]).toMatch(/^MC_AUTO_CONNECT:/)
  })

  it.each(['0', '65536', '-1', 'abc', '80.5'])('rejects invalid MC_PORT=%s', (raw) => {
    expect(loadIssues({ MC_PORT: raw })[0]).toMatch(/^MC_PORT:/)
  })

  it.each(['1', '65535'])('accepts boundary MC_PORT=%s', (raw) => {
    expect(loadOk({ MC_PORT: raw }).port).toBe(Number(raw))
  })

  it('rejects an unknown auth mode', () => {
    expect(loadIssues({ MC_AUTH: 'token' })[0]).toMatch(/^MC_AUTH:/)
  })

  it('rejects an unknown log level', () => {
    expect(loadIssues({ LOG_LEVEL: 'verbose' })[0]).toMatch(/^LOG_LEVEL:/)
  })

  it('rejects a username longer than Minecraft allows', () => {
    expect(loadIssues({ MC_USERNAME: 'ThisNameIsTooLongForMinecraft' })[0]).toMatch(/^MC_USERNAME:/)
  })

  it.each(['0', '21', '-3', 'low'])('rejects invalid LOW_HEALTH_THRESHOLD=%s', (raw) => {
    expect(loadIssues({ LOW_HEALTH_THRESHOLD: raw })[0]).toMatch(/^LOW_HEALTH_THRESHOLD:/)
  })

  it('reports every problem at once', () => {
    const issues = loadIssues({ MC_PORT: 'x', LOG_LEVEL: 'loud', MC_AUTH: 'nope' })
    expect(issues).toHaveLength(3)
  })
})
