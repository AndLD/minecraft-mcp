import { describe, expect, it } from '@jest/globals'
import { parseLanAnnouncement, UdpLanDiscovery } from '../../../src/bot/udp-lan-discovery.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { FakeScheduler } from '../../fakes/fake-scheduler.js'
import { announcement, FakeSocket } from '../../fakes/fake-socket.js'

describe('parseLanAnnouncement', () => {
  it('reads the host player, world name, and port', () => {
    expect(
      parseLanAnnouncement('[MOTD]Andrey_Knight - AI bot test world[/MOTD][AD]34231[/AD]'),
    ).toEqual({
      port: 34231,
      hostPlayer: 'Andrey_Knight',
      worldName: 'AI bot test world',
    })
  })

  it('keeps dashes inside the world name', () => {
    expect(parseLanAnnouncement(announcement('Steve - My - World', 5000))).toEqual({
      port: 5000,
      hostPlayer: 'Steve',
      worldName: 'My - World',
    })
  })

  it('handles a message of the day without a host player', () => {
    expect(parseLanAnnouncement(announcement('A Minecraft Server', 25565))).toEqual({
      port: 25565,
      hostPlayer: undefined,
      worldName: 'A Minecraft Server',
    })
  })

  it.each([
    ['unrelated text', 'hello'],
    ['no port', '[MOTD]x - y[/MOTD]'],
    ['no message of the day', '[AD]25565[/AD]'],
    ['port zero', announcement('x - y', 0)],
    ['port too large', announcement('x - y', 70000)],
  ])('rejects %s', (_name, text) => {
    expect(parseLanAnnouncement(text)).toBeUndefined()
  })
})

describe('UdpLanDiscovery', () => {
  function setup() {
    const socket = new FakeSocket()
    const scheduler = new FakeScheduler(new FakeClock())
    const discovery = new UdpLanDiscovery(() => socket, scheduler)
    return { socket, scheduler, discovery }
  }

  it('joins the LAN multicast group', () => {
    const { socket, discovery, scheduler } = setup()
    void discovery.discover({ timeoutMs: 1000 })

    expect(socket.boundPort).toBe(4445)
    expect(socket.membership).toBe('224.0.2.60')
    scheduler.advance(1000)
  })

  it('returns the first announced world when no host is preferred, and closes the socket', async () => {
    const { socket, discovery, scheduler } = setup()
    const pending = discovery.discover({ timeoutMs: 4000 })

    socket.receive('not an announcement')
    socket.receive(announcement('Steve - First', 1111))
    socket.receive(announcement('Alex - Second', 2222))

    expect(await pending).toEqual({ port: 1111, hostPlayer: 'Steve', worldName: 'First' })
    expect(socket.closed).toBe(true)
    expect(scheduler.pendingCount).toBe(0)
  })

  it('returns immediately for the preferred host, whatever the case', async () => {
    const { socket, discovery } = setup()
    const pending = discovery.discover({ timeoutMs: 4000, preferHostPlayer: 'andrey_knight' })

    socket.receive(announcement('Steve - Other', 1111))
    socket.receive(announcement('Andrey_Knight - Mine', 2222))

    expect(await pending).toEqual({ port: 2222, hostPlayer: 'Andrey_Knight', worldName: 'Mine' })
  })

  it('falls back to the first world seen when the preferred host never shows up', async () => {
    const { socket, discovery, scheduler } = setup()
    const pending = discovery.discover({ timeoutMs: 4000, preferHostPlayer: 'Andrey_Knight' })
    socket.receive(announcement('Steve - Other', 1111))

    scheduler.advance(4000)

    expect(await pending).toEqual({ port: 1111, hostPlayer: 'Steve', worldName: 'Other' })
    expect(socket.closed).toBe(true)
  })

  it('returns nothing when no world is announced in time', async () => {
    const { socket, discovery, scheduler } = setup()
    const pending = discovery.discover({ timeoutMs: 4000 })

    scheduler.advance(4000)

    expect(await pending).toBeUndefined()
    expect(socket.closed).toBe(true)
  })

  it('returns what it has when the socket fails', async () => {
    const { socket, discovery } = setup()
    const pending = discovery.discover({ timeoutMs: 4000 })

    socket.fail(new Error('EADDRINUSE'))

    expect(await pending).toBeUndefined()
  })

  it('gives up when multicast cannot be joined', async () => {
    const { socket, discovery } = setup()
    socket.failMembership = true

    expect(await discovery.discover({ timeoutMs: 4000 })).toBeUndefined()
    expect(socket.closed).toBe(true)
  })

  it('tolerates a socket that throws on close', async () => {
    const { socket, discovery, scheduler } = setup()
    socket.close = () => {
      throw new Error('already closed')
    }
    const pending = discovery.discover({ timeoutMs: 100 })

    scheduler.advance(100)

    expect(await pending).toBeUndefined()
  })
})
