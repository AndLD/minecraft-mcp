import { describe, expect, it } from '@jest/globals'
import { SessionService } from '../../../src/session/session-service.js'
import { FakeConnection, FakeLanDiscovery } from '../../fakes/fake-ports.js'
import { FakeLogger } from '../../fakes/fake-logger.js'
import { buildConfig } from '../../fakes/test-config.js'
import { buildStateStack, FakeWorldIdentifier } from '../../fakes/state-fakes.js'
import type { Config } from '../../../src/config/config.types.js'

function setup(config: Partial<Config> = {}) {
  const connection = new FakeConnection()
  const lan = new FakeLanDiscovery()
  const identifier = new FakeWorldIdentifier()
  const stack = buildStateStack()
  const session = new SessionService({
    config: buildConfig(config),
    connection,
    lanDiscovery: lan,
    logger: new FakeLogger(),
    identifier,
    worldState: stack.worldState,
    discoveryTimeoutMs: 2500,
  })
  return { session, connection, lan, identifier, stack }
}

describe('SessionService', () => {
  it('connects with the configured host and port', async () => {
    const { session, connection } = setup({ host: 'mc.local', port: 25565 })

    const result = await session.connect()

    expect(result).toMatchObject({
      ok: true,
      value: {
        username: 'ClaudeBot',
        version: '1.21.1',
        host: 'mc.local',
        port: 25565,
        worldName: undefined,
        world: { profile: 'survival', resolution: { kind: 'created' } },
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

describe('SessionService and the world state', () => {
  it('identifies the world after joining and passes the LAN world name as a hint', async () => {
    const { session, identifier, lan } = setup({ port: undefined })
    lan.world = { port: 34231, worldName: 'AI bot test world', hostPlayer: 'Andrey_Knight' }

    const result = await session.connect()

    expect(identifier.calls).toEqual([
      { target: expect.objectContaining({ port: 34231 }), hint: 'AI bot test world' },
    ])
    expect(result).toMatchObject({ ok: true, value: { world: { profile: 'ai-bot-test-world' } } })
  })

  it('recognizes the same world on the next connect', async () => {
    const { session, connection } = setup({ port: 25565 })
    await session.connect()
    connection.state = 'disconnected'

    const again = await session.connect()

    expect(again).toMatchObject({
      ok: true,
      value: { world: { resolution: { kind: 'matched', profile: 'survival' } } },
    })
  })

  it('uses the fallback name (request, then WORLD_PROFILE) only when the world cannot be identified', async () => {
    const unnamed = { seed: null, worldName: null, spawn: null }

    const viaRequest = setup({ port: 25565 })
    viaRequest.identifier.fingerprint = unnamed
    expect(await viaRequest.session.connect({ profile: 'From Request' })).toMatchObject({
      value: { world: { profile: 'from-request', resolution: { kind: 'created', named: true } } },
    })

    const viaConfig = setup({ port: 25565, worldProfile: 'from-config' })
    viaConfig.identifier.fingerprint = unnamed
    expect(await viaConfig.session.connect()).toMatchObject({
      value: { world: { profile: 'from-config' } },
    })

    const ignored = setup({ port: 25565, worldProfile: 'ignored' })
    expect(await ignored.session.connect()).toMatchObject({
      value: { world: { profile: 'survival' } },
    })
  })

  it('leaves the world unresolved when it cannot be identified and no name was given', async () => {
    const { session, identifier } = setup({ port: 25565 })
    identifier.fingerprint = { seed: null, worldName: null, spawn: null }

    const result = await session.connect()

    expect(result).toMatchObject({
      ok: true,
      value: { world: { profile: undefined, resolution: { kind: 'needs_name' } } },
    })
  })

  it('still connects when identification fails, with no way to recognize the world', async () => {
    const { session, identifier } = setup({ port: 25565 })
    identifier.failWith = new Error('boom')

    const result = await session.connect()

    expect(result).toMatchObject({
      ok: true,
      value: { world: { resolution: { kind: 'needs_name' } } },
    })
  })

  describe('nameWorld', () => {
    it('binds the connected world to a name', async () => {
      const { session, identifier } = setup({ port: 25565 })
      identifier.fingerprint = { seed: null, worldName: null, spawn: null }
      await session.connect()

      const named = await session.nameWorld('My World')

      expect(named).toMatchObject({ ok: true, value: { profile: 'my-world' } })
    })

    it('needs a connection', async () => {
      const { session } = setup({ port: 25565 })

      expect(await session.nameWorld('x')).toEqual({
        ok: false,
        error: 'Not connected to a Minecraft world. Call connect first.',
      })
    })

    it('rejects a name with nothing usable in it', async () => {
      const { session, connection } = setup({ port: 25565 })
      await session.connect()
      connection.state = 'connected'

      const named = await session.nameWorld('///')

      expect(named.ok).toBe(false)
    })
  })
})
