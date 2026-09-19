import { describe, expect, it } from '@jest/globals'
import { AgentInbox } from '../../../../src/chat/agent-inbox.js'
import { ConnectTool } from '../../../../src/mcp/tools/connect-tool.js'
import { DisconnectTool } from '../../../../src/mcp/tools/disconnect-tool.js'
import { GetStatusTool } from '../../../../src/mcp/tools/get-status-tool.js'
import { MAX_CHAT_LINES, SayTool } from '../../../../src/mcp/tools/say-tool.js'
import { WaitForChatTool } from '../../../../src/mcp/tools/wait-for-chat-tool.js'
import { WhisperTool } from '../../../../src/mcp/tools/whisper-tool.js'
import type { ToolContext } from '../../../../src/mcp/tool.types.js'
import { SessionService } from '../../../../src/session/session-service.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import {
  FakeChatPort,
  FakeConnection,
  FakeLanDiscovery,
  FakeVitals,
  buildVitals,
} from '../../../fakes/fake-ports.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'
import { buildConfig } from '../../../fakes/test-config.js'
import { buildStateStack, FakeWorldIdentifier } from '../../../fakes/state-fakes.js'

const context = (signal: AbortSignal = new AbortController().signal): ToolContext => ({ signal })

function inboxSetup() {
  const clock = new FakeClock(Date.UTC(2026, 8, 19, 12, 0, 0))
  const scheduler = new FakeScheduler(clock)
  return { clock, scheduler, inbox: new AgentInbox({ clock, scheduler }) }
}

describe('ConnectTool', () => {
  function setup() {
    const connection = new FakeConnection()
    const stack = buildStateStack()
    const session = new SessionService({
      config: buildConfig({ port: 25565 }),
      connection,
      lanDiscovery: new FakeLanDiscovery(),
      logger: new FakeLogger(),
      identifier: new FakeWorldIdentifier(),
      worldState: stack.worldState,
    })
    return { tool: new ConnectTool(session, stack.briefing), connection }
  }

  it('connects and reports the session', async () => {
    const { tool } = setup()

    const result = await tool.execute({ port: 34231 })

    expect(result).toMatchObject({
      ok: true,
      data: {
        connected: true,
        username: 'ClaudeBot',
        version: '1.21.1',
        host: 'localhost',
        port: 34231,
        briefing: { world: { profile: 'survival' }, previousSession: null },
      },
    })
  })

  it('fails with the reason when connecting is not possible', async () => {
    const { tool, connection } = setup()
    connection.failWith('Connection error: ECONNREFUSED')

    expect(await tool.execute({})).toEqual({ ok: false, error: 'Connection error: ECONNREFUSED' })
  })

  it('validates the port range in its schema', () => {
    const { tool } = setup()

    expect(tool.inputSchema.safeParse({ port: 0 }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ port: 70000 }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ port: 34231, host: 'localhost' }).success).toBe(true)
    expect(tool.inputSchema.safeParse({}).success).toBe(true)
  })
})

describe('DisconnectTool', () => {
  it('disconnects and says whether it was connected', async () => {
    const connection = new FakeConnection()
    connection.state = 'connected'
    const tool = new DisconnectTool(connection)

    expect(await tool.execute()).toEqual({
      ok: true,
      data: { disconnected: true, wasConnected: true },
    })
    expect(await tool.execute()).toEqual({
      ok: true,
      data: { disconnected: true, wasConnected: false },
    })
    expect(connection.disconnectCalls).toBe(2)
  })
})

describe('GetStatusTool', () => {
  it('reports a disconnected bot', () => {
    const { inbox } = inboxSetup()
    const tool = new GetStatusTool(new FakeConnection(), new FakeVitals(), inbox)

    expect(tool.execute()).toEqual({
      ok: true,
      data: {
        state: 'disconnected',
        target: null,
        vitals: null,
        pendingInbox: 0,
        commands: { canTeleport: null },
        reflexes: null,
      },
    })
  })

  it('reports the target, vitals, and pending items when connected', async () => {
    const { inbox } = inboxSetup()
    const connection = new FakeConnection()
    await connection.connect({
      host: 'localhost',
      port: 34231,
      username: 'ClaudeBot',
      version: '1.21.1',
      auth: 'offline',
    })
    const vitals = new FakeVitals()
    vitals.vitals = buildVitals({ food: 18, position: { x: 1, y: 64, z: 2 }, timeOfDay: 1000 })
    inbox.pushMessage({ sender: 'A', text: 'hi', whisper: false })
    const tool = new GetStatusTool(connection, vitals, inbox)

    expect(tool.execute()).toEqual({
      ok: true,
      data: {
        state: 'connected',
        target: { host: 'localhost', port: 34231, username: 'ClaudeBot', version: '1.21.1' },
        vitals: vitals.vitals,
        pendingInbox: 1,
        commands: { canTeleport: null },
        reflexes: null,
      },
    })
  })
})

describe('GetStatusTool reflexes', () => {
  it('reports whether the reflexes are enabled and which one is acting', () => {
    const { inbox } = inboxSetup()
    const tool = new GetStatusTool(new FakeConnection(), new FakeVitals(), inbox, {
      enabled: true,
      activeReflex: () => 'threat_response',
    })

    expect(tool.execute()).toMatchObject({
      data: { reflexes: { enabled: true, active: 'threat_response' } },
    })
  })

  it('reports no active reflex', () => {
    const { inbox } = inboxSetup()
    const tool = new GetStatusTool(new FakeConnection(), new FakeVitals(), inbox, {
      enabled: false,
      activeReflex: () => undefined,
    })

    expect(tool.execute()).toMatchObject({ data: { reflexes: { enabled: false, active: null } } })
  })
})

describe('WaitForChatTool', () => {
  it('fails when disconnected and nothing is pending', async () => {
    const { inbox } = inboxSetup()
    const tool = new WaitForChatTool(new FakeConnection(), inbox)

    expect(await tool.execute({ timeout_seconds: 30 }, context())).toEqual({
      ok: false,
      error: 'Not connected to a Minecraft world. Call connect first.',
    })
  })

  it('still delivers pending events after a disconnect', async () => {
    const { inbox } = inboxSetup()
    inbox.pushEvent({ type: 'disconnected', message: 'Disconnected: socketClosed' })
    const tool = new WaitForChatTool(new FakeConnection(), inbox)

    const result = await tool.execute({ timeout_seconds: 30 }, context())

    expect(result).toMatchObject({
      ok: true,
      data: { timedOut: false, events: [{ type: 'disconnected' }] },
    })
  })

  it('returns messages and events with ISO timestamps', async () => {
    const { inbox } = inboxSetup()
    const connection = new FakeConnection()
    connection.state = 'connected'
    inbox.pushMessage({ sender: 'Andrey_Knight', text: 'hello', whisper: true })
    inbox.pushEvent({ type: 'connected', message: 'joined' })
    const tool = new WaitForChatTool(connection, inbox)

    const result = await tool.execute({ timeout_seconds: 30 }, context())

    expect(result).toEqual({
      ok: true,
      data: {
        timedOut: false,
        messages: [
          { sender: 'Andrey_Knight', text: 'hello', whisper: true, at: '2026-09-19T12:00:00.000Z' },
        ],
        events: [{ type: 'connected', message: 'joined', at: '2026-09-19T12:00:00.000Z' }],
        dropped: 0,
      },
    })
  })

  it('times out with an empty result', async () => {
    const { inbox, scheduler } = inboxSetup()
    const connection = new FakeConnection()
    connection.state = 'connected'
    const tool = new WaitForChatTool(connection, inbox)

    const pending = tool.execute({ timeout_seconds: 5 }, context())
    scheduler.advance(5000)

    expect(await pending).toEqual({
      ok: true,
      data: { timedOut: true, messages: [], events: [], dropped: 0 },
    })
  })

  it('ends the wait when the request is cancelled', async () => {
    const { inbox } = inboxSetup()
    const connection = new FakeConnection()
    connection.state = 'connected'
    const controller = new AbortController()
    const tool = new WaitForChatTool(connection, inbox)

    const pending = tool.execute({ timeout_seconds: 30 }, context(controller.signal))
    controller.abort()

    expect(await pending).toMatchObject({ ok: true, data: { timedOut: true } })
  })

  it('defaults to 30 seconds and rejects timeouts above the limit', () => {
    const tool = new WaitForChatTool(new FakeConnection(), inboxSetup().inbox)

    expect(tool.inputSchema.parse({})).toEqual({ timeout_seconds: 30 })
    expect(tool.inputSchema.safeParse({ timeout_seconds: 56 }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ timeout_seconds: 0 }).success).toBe(false)
  })
})

describe('SayTool', () => {
  it('says the text in chat', () => {
    const chat = new FakeChatPort()

    expect(new SayTool(chat).execute({ text: 'Hello!' })).toEqual({
      ok: true,
      data: { sent: 1, truncated: false },
    })
    expect(chat.said).toEqual(['Hello!'])
  })

  it('splits long text and truncates beyond the line limit', () => {
    const chat = new FakeChatPort()
    const text = Array.from({ length: MAX_CHAT_LINES + 2 }, (_, i) => `line ${String(i)}`).join(
      '\n',
    )

    const result = new SayTool(chat).execute({ text })

    expect(result).toEqual({ ok: true, data: { sent: MAX_CHAT_LINES, truncated: true } })
    expect(chat.said).toHaveLength(MAX_CHAT_LINES)
  })

  it('fails when there is nothing to say', () => {
    expect(new SayTool(new FakeChatPort()).execute({ text: '  \n ' })).toEqual({
      ok: false,
      error: 'Nothing to say: the text is empty.',
    })
  })

  it('fails when not connected', () => {
    const chat = new FakeChatPort()
    chat.connected = false

    expect(new SayTool(chat).execute({ text: 'hi' })).toEqual({
      ok: false,
      error: 'Not connected to a Minecraft world.',
    })
  })
})

describe('WhisperTool', () => {
  it('whispers to the player', () => {
    const chat = new FakeChatPort()

    const result = new WhisperTool(chat).execute({ player: 'Andrey_Knight', text: 'psst' })

    expect(result).toEqual({ ok: true, data: { sent: 1, player: 'Andrey_Knight' } })
    expect(chat.whispered).toEqual([{ player: 'Andrey_Knight', text: 'psst' }])
  })

  it('fails when there is nothing to say', () => {
    expect(new WhisperTool(new FakeChatPort()).execute({ player: 'A', text: '' })).toEqual({
      ok: false,
      error: 'Nothing to say: the text is empty.',
    })
  })

  it('fails when not connected', () => {
    const chat = new FakeChatPort()
    chat.connected = false

    expect(new WhisperTool(chat).execute({ player: 'A', text: 'hi' }).ok).toBe(false)
  })
})
