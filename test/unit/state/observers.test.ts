import { describe, expect, it } from '@jest/globals'
import { z } from 'zod'
import { AgentInbox } from '../../../src/chat/agent-inbox.js'
import { ToolRegistry, type ToolCall } from '../../../src/mcp/tool-registry.js'
import { toolFail, toolOk } from '../../../src/mcp/tool-result.js'
import { describeToolCall, HISTORY_IGNORED_TOOLS } from '../../../src/state/history-format.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { FakeLogger } from '../../fakes/fake-logger.js'
import { FakeScheduler } from '../../fakes/fake-scheduler.js'

describe('AgentInbox observers', () => {
  it('reports every message and event, stamped, as it arrives', () => {
    const clock = new FakeClock(5000)
    const seen: string[] = []
    const inbox = new AgentInbox({
      clock,
      scheduler: new FakeScheduler(clock),
      onMessage: (m) => seen.push(`message:${m.text}@${String(m.receivedAt)}`),
      onEvent: (e) => seen.push(`event:${e.type}@${String(e.at)}`),
    })

    inbox.pushMessage({ sender: 'A', text: 'hi', whisper: false })
    inbox.pushEvent({ type: 'connected', message: 'joined' })

    expect(seen).toEqual(['message:hi@5000', 'event:connected@5000'])
  })
})

describe('ToolRegistry observer', () => {
  const context = { signal: new AbortController().signal }
  const schema = z.object({ n: z.number().optional() })

  function setup() {
    const calls: ToolCall[] = []
    const registry = new ToolRegistry(new FakeLogger(), { onCall: (call) => calls.push(call) })
      .register({
        name: 'good',
        description: 'x',
        inputSchema: schema,
        execute: () => toolOk('done'),
      })
      .register({
        name: 'bad',
        description: 'x',
        inputSchema: schema,
        execute: () => toolFail('nope'),
      })
    return { calls, registry }
  }

  it('reports each finished call with its arguments and result', async () => {
    const { calls, registry } = setup()

    await registry.call('good', { n: 1 }, context)
    await registry.call('bad', {}, context)

    expect(calls).toEqual([
      { name: 'good', args: { n: 1 }, result: { ok: true, data: 'done' } },
      { name: 'bad', args: {}, result: { ok: false, error: 'nope' } },
    ])
  })

  it('reports unknown tools and invalid arguments too', async () => {
    const { calls, registry } = setup()

    await registry.call('missing', {}, context)
    await registry.call('good', { n: 'x' }, context)

    expect(calls.map((c) => c.result.ok)).toEqual([false, false])
  })

  it('works without an observer', async () => {
    const registry = new ToolRegistry(new FakeLogger()).register({
      name: 'good',
      description: 'x',
      inputSchema: schema,
      execute: () => toolOk(1),
    })

    expect(await registry.call('good', {}, context)).toEqual({ ok: true, data: 1 })
  })
})

describe('describeToolCall', () => {
  it('describes an acting tool call with its outcome', () => {
    expect(
      describeToolCall({
        name: 'goto',
        args: { x: 1, y: 2, z: 3 },
        result: { ok: true, data: {} },
      }),
    ).toBe('goto({"x":1,"y":2,"z":3}) → ok')
    expect(
      describeToolCall({
        name: 'goto',
        args: {},
        result: { ok: false, error: 'No path. (reason: unreachable)' },
      }),
    ).toBe('goto() → failed: No path. (reason: unreachable)')
    expect(
      describeToolCall({ name: 'stop', args: undefined, result: { ok: true, data: {} } }),
    ).toBe('stop() → ok')
  })

  it.each([...HISTORY_IGNORED_TOOLS])('does not record the read-only tool %s', (name) => {
    expect(describeToolCall({ name, args: {}, result: { ok: true, data: {} } })).toBeUndefined()
  })

  it('records the tools that change things', () => {
    for (const name of ['connect', 'say', 'remember', 'goto', 'follow_player', 'stop']) {
      expect(HISTORY_IGNORED_TOOLS.has(name)).toBe(false)
    }
  })
})
