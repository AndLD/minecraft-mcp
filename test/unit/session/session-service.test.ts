import { describe, expect, it } from '@jest/globals'
import { SessionService } from '../../../src/session/session-service.js'
import { FakeConnection, FakeLanDiscovery } from '../../fakes/fake-ports.js'
import { FakeLogger } from '../../fakes/fake-logger.js'
import { buildConfig } from '../../fakes/test-config.js'
import type { Config } from '../../../src/config/config.types.js'

function setup(config: Partial<Config> = {}) {
  const connection = new FakeConnection()
  const lan = new FakeLanDiscovery()
  const session = new SessionService({
    config: buildConfig(config),
    connection,
    lanDiscovery: lan,
    logger: new FakeLogger(),
    discoveryTimeoutMs: 2500,
  })
  return { session, connection, lan }
}

describe('SessionService', () => {
  it('connects with the configured host and port', async () => {
    const { session, connection } = setup({ host: 'mc.local', port: 25565 })

    const result = await session.connect()

    expect(result).toEqual({
      ok: true,
      value: {
        username: 'ClaudeBot',
        version: '1.21.1',
        host: 'mc.local',
        port: 25565,
        worldName: undefined,
      },
    })
    expect(connection.connectCalls).toEqual([
      { host: 'mc.local', port: 25565, username: 'TestBot', version: '1.21.1', auth: 'offline' },
    ])
  })

  it('prefers the host and port from the request over the config', async () => {
    const { session, connection } = setup({ host: 'mc.local', port: 25565 })

    await session.connect({ host: 'other', port: 30000 })

    expect(connection.connectCalls[0]).toMatchObject({ host: 'other', port: 30000 })
  })

  it('does not listen for a LAN world when a port is known', async () => {
    const { session, lan } = setup({ port: 25565 })

    await session.connect()

    expect(lan.calls).toEqual([])
  })

  it('discovers the port from the LAN announcement, preferring the owner’s world', async () => {
    const { session, connection, lan } = setup({ port: undefined, owner: 'Andrey_Knight' })
    lan.world = { port: 34231, worldName: 'AI bot test world', hostPlayer: 'Andrey_Knight' }

    const result = await session.connect()

    expect(lan.calls).toEqual([{ timeoutMs: 2500, preferHostPlayer: 'Andrey_Knight' }])
    expect(connection.connectCalls[0]).toMatchObject({ host: 'localhost', port: 34231 })
    expect(result).toMatchObject({
      ok: true,
      value: { port: 34231, worldName: 'AI bot test world' },
    })
  })

  it('discovers the port without a preference when no owner is configured', async () => {
    const { session, lan } = setup({ port: undefined, owner: undefined })
    lan.world = { port: 1234, worldName: 'w', hostPlayer: undefined }

    await session.connect()

    expect(lan.calls).toEqual([{ timeoutMs: 2500 }])
  })

  it('explains what to do when no LAN world is found', async () => {
    const { session, connection } = setup({ port: undefined })

    const result = await session.connect()

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain('Open to LAN')
    expect(connection.connectCalls).toEqual([])
  })

  it('refuses to connect twice', async () => {
    const { session, connection } = setup({ port: 25565 })
    connection.state = 'connected'

    const result = await session.connect()

    expect(result).toEqual({
      ok: false,
      error: 'Already connected. Call disconnect first to reconnect elsewhere.',
    })
    expect(connection.connectCalls).toEqual([])
  })

  it('passes a connection failure through', async () => {
    const { session, connection } = setup({ port: 25565 })
    connection.failWith('Connection error: ECONNREFUSED')

    expect(await session.connect()).toEqual({ ok: false, error: 'Connection error: ECONNREFUSED' })
  })
})
