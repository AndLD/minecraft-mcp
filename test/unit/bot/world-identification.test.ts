import { describe, expect, it } from '@jest/globals'
import { formatHashedSeed } from '../../../src/bot/hashed-seed.js'
import { MinecraftServerStatusProbe } from '../../../src/bot/minecraft-status-probe.js'
import { flattenMotd, splitMotd } from '../../../src/bot/motd.js'
import { MineflayerWorldIdentifier } from '../../../src/bot/mineflayer-world-identifier.js'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import type { ConnectTarget } from '../../../src/core/connection.port.js'
import { FakeBot } from '../../fakes/fake-bot.js'
import { FakeStatusProbe } from '../../fakes/fake-ports.js'

const target: ConnectTarget = {
  host: 'localhost',
  port: 34231,
  username: 'ClaudeBot',
  version: '1.21.1',
  auth: 'offline',
}
const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})

describe('formatHashedSeed', () => {
  it('joins the two 32-bit halves of the login packet into one hex string', () => {
    // The seed seen in the real LAN world during the feasibility spike.
    expect(formatHashedSeed([1730125407, 170662117])).toBe('671f9e5f0a2c18e5')
  })

  it('treats negative halves as unsigned', () => {
    expect(formatHashedSeed([-1, -1])).toBe('ffffffffffffffff')
    expect(formatHashedSeed([0, -2])).toBe('fffffffe')
  })

  it('handles single 64-bit values as bigint, integer, or numeric string', () => {
    expect(formatHashedSeed(255n)).toBe('ff')
    expect(formatHashedSeed(255)).toBe('ff')
    expect(formatHashedSeed('255')).toBe('ff')
    expect(formatHashedSeed(-1n)).toBe('ffffffffffffffff')
    expect(formatHashedSeed('-1')).toBe('ffffffffffffffff')
  })

  it.each([undefined, null, [], [1], [1, 2, 3], ['a', 'b'], 1.5, 'abc', {}])(
    'has no seed in %j',
    (raw) => {
      expect(formatHashedSeed(raw)).toBeUndefined()
    },
  )

  it('does not throw on values BigInt cannot take', () => {
    expect(formatHashedSeed([Number.NaN, 1])).toBeUndefined()
  })
})

describe('flattenMotd', () => {
  it('keeps plain text', () => {
    expect(flattenMotd('Andrey_Knight - AI bot test world')).toBe(
      'Andrey_Knight - AI bot test world',
    )
  })

  it('flattens chat components with extras and strips color codes', () => {
    expect(flattenMotd({ text: '§aMy ', extra: [{ text: 'Server' }, ' §r!'] })).toBe('My Server !')
    expect(flattenMotd([{ text: 'a' }, 'b'])).toBe('ab')
  })

  it('gives an empty string for anything else', () => {
    expect(flattenMotd(undefined)).toBe('')
    expect(flattenMotd(42)).toBe('')
    expect(flattenMotd({ text: 5 })).toBe('')
  })
})

describe('splitMotd', () => {
  it('splits a LAN message of the day into host player and world name', () => {
    expect(splitMotd('Andrey_Knight - AI bot test world')).toEqual({
      hostPlayer: 'Andrey_Knight',
      worldName: 'AI bot test world',
    })
    expect(splitMotd('Steve - My - World')).toEqual({
      hostPlayer: 'Steve',
      worldName: 'My - World',
    })
  })

  it('uses another server’s message of the day as it is', () => {
    expect(splitMotd('A Minecraft Server')).toEqual({
      hostPlayer: undefined,
      worldName: 'A Minecraft Server',
    })
  })
})

describe('MinecraftServerStatusProbe', () => {
  it('reads the message of the day from the status ping', async () => {
    const calls: unknown[] = []
    const probe = new MinecraftServerStatusProbe((options) => {
      calls.push(options)
      return Promise.resolve({ description: { text: 'Andrey_Knight - AI bot test world' } })
    })

    expect(await probe.probe('localhost', 34231)).toEqual({
      motd: 'Andrey_Knight - AI bot test world',
    })
    expect(calls).toEqual([{ host: 'localhost', port: 34231, closeTimeout: 3000 }])
  })

  it('understands the older motd field', async () => {
    const probe = new MinecraftServerStatusProbe(() => Promise.resolve({ motd: 'Old server' }))

    expect(await probe.probe('h', 1)).toEqual({ motd: 'Old server' })
  })

  it('gives nothing for an empty message or a server that does not answer', async () => {
    expect(
      await new MinecraftServerStatusProbe(() => Promise.resolve({ description: '' })).probe(
        'h',
        1,
      ),
    ).toBeUndefined()
    expect(
      await new MinecraftServerStatusProbe(() => Promise.reject(new Error('ECONNREFUSED'))).probe(
        'h',
        1,
      ),
    ).toBeUndefined()
  })

  it('uses the real ping by default (unreachable port gives nothing)', async () => {
    expect(await new MinecraftServerStatusProbe().probe('127.0.0.1', 1)).toBeUndefined()
  })
})

describe('MineflayerWorldIdentifier', () => {
  function botWith(seed: string | undefined, spawn = { x: 48, y: 81, z: 32 }): FakeBot {
    const bot = new FakeBot()
    bot.worldSeed = seed
    bot.spawnPoint = spawn
    return bot
  }

  it('combines the seed, the spawn point, and the world name from the server status', async () => {
    const probe = new FakeStatusProbe()
    probe.status = { motd: 'Andrey_Knight - AI bot test world' }

    const fingerprint = await new MineflayerWorldIdentifier(
      holderOf(botWith('671fd0df')),
      probe,
    ).identify(target)

    expect(fingerprint).toEqual({
      seed: '671fd0df',
      worldName: 'AI bot test world',
      spawn: { x: 48, y: 81, z: 32 },
    })
    expect(probe.probed).toEqual([{ host: 'localhost', port: 34231 }])
  })

  it('skips asking the server when the world name is already known', async () => {
    const probe = new FakeStatusProbe()

    const fingerprint = await new MineflayerWorldIdentifier(
      holderOf(botWith('aa')),
      probe,
    ).identify(target, 'Known World')

    expect(fingerprint.worldName).toBe('Known World')
    expect(probe.probed).toEqual([])
  })

  it('has no world name when the server does not answer', async () => {
    const fingerprint = await new MineflayerWorldIdentifier(
      holderOf(botWith('aa')),
      new FakeStatusProbe(),
    ).identify(target)

    expect(fingerprint.worldName).toBeNull()
  })

  it('has no world name for an empty name after the separator', async () => {
    const probe = new FakeStatusProbe()
    probe.status = { motd: 'Steve - ' }

    expect(
      (await new MineflayerWorldIdentifier(holderOf(botWith('aa')), probe).identify(target))
        .worldName,
    ).toBeNull()
  })

  it('has no seed when the login packet gave none, and ignores a spawn that was never sent', async () => {
    const fingerprint = await new MineflayerWorldIdentifier(
      holderOf(botWith(undefined, { x: 0, y: 0, z: 0 })),
      new FakeStatusProbe(),
    ).identify(target)

    expect(fingerprint).toEqual({ seed: null, worldName: null, spawn: null })
  })

  it('keeps a spawn at x=0, z=0 when the height is real', async () => {
    const fingerprint = await new MineflayerWorldIdentifier(
      holderOf(botWith('aa', { x: 0, y: 70, z: 0 })),
      new FakeStatusProbe(),
    ).identify(target, 'W')

    expect(fingerprint.spawn).toEqual({ x: 0, y: 70, z: 0 })
  })

  it('has only the world name without a bot', async () => {
    const fingerprint = await new MineflayerWorldIdentifier(
      holderOf(undefined),
      new FakeStatusProbe(),
    ).identify(target, 'W')

    expect(fingerprint).toEqual({ seed: null, worldName: 'W', spawn: null })
  })
})
