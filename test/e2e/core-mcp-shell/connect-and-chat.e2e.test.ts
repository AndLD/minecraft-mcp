import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals'
import { E2EWorld } from '../support/e2e-world.js'
import { joinAsPlayer } from '../support/player-bot.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { serverLog } from '../support/server-log.js'
import { startSession, type E2ESession } from '../support/session.js'
import { waitUntil } from '../support/wait.js'

interface WaitData {
  messages: { sender: string; text: string; whisper: boolean }[]
  events: { type: string; message: string }[]
}

describe('connecting and chatting on a real Minecraft server', () => {
  let info: ServerInfo
  let world: E2EWorld
  let session: E2ESession | undefined

  beforeAll(async () => {
    info = readServerInfo()
    world = await E2EWorld.connect(info)
    await world.setGameRule('doDaylightCycle', false)
    await world.setTime('day')
  })

  afterEach(async () => {
    await session?.close()
    session = undefined
  })

  afterAll(async () => {
    await world.close()
  })

  /** Reads wait_for_chat until the predicate holds (chat and events arrive separately). */
  async function listenUntil(
    current: E2ESession,
    done: (seen: WaitData) => boolean,
  ): Promise<WaitData> {
    const seen: WaitData = { messages: [], events: [] }
    await waitUntil(
      async () => {
        const result = await current.bot.call('wait_for_chat', { timeout_seconds: 2 })
        const data = result.data as (WaitData & { timedOut: boolean }) | undefined
        if (data === undefined) return undefined
        seen.messages.push(...data.messages)
        seen.events.push(...data.events)
        return done(seen) ? true : undefined
      },
      { timeoutMs: 20_000, intervalMs: 50, description: 'the expected chat or event' },
    )
    return seen
  }

  it('joins the server and shows up in the player list with real vitals', async () => {
    session = await startSession(world, info)

    const online = await world.onlinePlayers()
    const status = await session.bot.call('get_status')

    expect(online).toEqual(expect.arrayContaining([session.bot.username, session.player.username]))
    expect(status.data).toMatchObject({
      state: 'connected',
      target: { host: info.host, port: info.minecraftPort, username: session.bot.username },
      vitals: { health: 20, dimension: 'overworld' },
    })
  })

  it('says something that appears in the server chat', async () => {
    session = await startSession(world, info)
    const since = serverLog.mark()

    const said = await session.bot.call('say', { text: 'Hello from the e2e test' })

    expect(said.data).toEqual({ sent: 1, truncated: false })
    await serverLog.waitFor(new RegExp(`<${session.bot.username}> Hello from the e2e test`), since)
  })

  it('hears the owner in game chat through wait_for_chat', async () => {
    session = await startSession(world, info)

    session.player.chat('come here please')
    const seen = await listenUntil(session, (s) =>
      s.messages.some((m) => m.text === 'come here please'),
    )

    expect(seen.messages).toContainEqual({
      sender: session.player.username,
      text: 'come here please',
      whisper: false,
      at: expect.any(String),
    })
    expect(seen.events.map((e) => e.type)).toContain('connected')
  })

  it('ignores chat from players who are not the owner', async () => {
    session = await startSession(world, info)
    const stranger = await joinAsPlayer(
      info,
      `Stranger${String(Math.floor(Math.random() * 10_000))}`,
    )
    try {
      stranger.chat('give me your diamonds')
      await serverLog.waitFor(new RegExp(`<${stranger.username}> give me your diamonds`), 0)
      session.player.chat('hello owner')

      const seen = await listenUntil(session, (s) =>
        s.messages.some((m) => m.text === 'hello owner'),
      )

      expect(seen.messages.map((m) => m.text)).not.toContain('give me your diamonds')
    } finally {
      await stranger.quit()
    }
  })

  it('disconnects on request and leaves the server', async () => {
    session = await startSession(world, info)

    const result = await session.bot.call('disconnect')

    expect(result.data).toEqual({ disconnected: true, wasConnected: true })
    await waitUntil(
      async () => !(await world.onlinePlayers()).includes(session?.bot.username ?? ''),
      {
        description: 'the bot to leave the player list',
      },
    )
  })

  it('tells the agent when the server kicks the bot', async () => {
    session = await startSession(world, info)

    await world.command(`kick ${session.bot.username} Testing a kick`)
    const seen = await listenUntil(session, (s) => s.events.some((e) => e.type === 'disconnected'))

    expect(seen.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['kicked', 'disconnected']),
    )
    expect((await session.bot.call('get_status')).data).toMatchObject({ state: 'disconnected' })
  })
})
