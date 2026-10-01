import { describe, expect, it } from '@jest/globals'
import type {
  Connection,
  ConnectionEvent,
  ConnectTarget,
} from '../../../src/core/connection.port.js'
import { err, ok, type Result } from '../../../src/core/result.js'
import type { Scheduler } from '../../../src/core/scheduler.port.js'
import { ReconnectSupervisor } from '../../../src/session/reconnect-supervisor.js'
import { FakeLogger } from '../../fakes/fake-logger.js'

const TARGET: ConnectTarget = {
  host: 'localhost',
  port: 25565,
  username: 'Bot',
  version: '1.21.1',
  auth: 'offline',
}

/** A scheduler the test runs by hand. */
class Manual implements Scheduler {
  readonly pending: { delayMs: number; callback: () => void; cancelled: boolean }[] = []
  after(delayMs: number, callback: () => void): () => void {
    const entry = { delayMs, callback, cancelled: false }
    this.pending.push(entry)
    return () => {
      entry.cancelled = true
    }
  }
  /** Runs the next timer that was not cancelled, and lets the promise it starts settle. */
  async fire(): Promise<number | undefined> {
    const entry = this.pending.find((e) => !e.cancelled)
    if (entry === undefined) return undefined
    this.pending.splice(this.pending.indexOf(entry), 1)
    entry.callback()
    await new Promise((resolve) => setImmediate(resolve))
    return entry.delayMs
  }
  live(): number {
    return this.pending.filter((e) => !e.cancelled).length
  }
}

function setup(attempts: number, results: Result<unknown>[] = []) {
  const scheduler = new Manual()
  const listeners = new Set<(event: ConnectionEvent) => void>()
  const connection = {
    state: 'connected' as Connection['state'],
    target: TARGET as ConnectTarget | undefined,
    connect: () => Promise.resolve(err('unused')),
    disconnect: () => Promise.resolve(),
    onEvent: (listener: (event: ConnectionEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const events: { type: string; message: string }[] = []
  const calls: { host?: string | undefined; port?: number | undefined }[] = []
  const supervisor = new ReconnectSupervisor({
    connection,
    session: {
      connect: (request) => {
        calls.push({ host: request?.host, port: request?.port })
        const next = results.shift() ?? err('refused')
        if (next.ok) connection.state = 'connected'
        return Promise.resolve(next as never)
      },
    },
    scheduler,
    logger: new FakeLogger(),
    attempts,
    emit: (type, message) => events.push({ type, message }),
  })
  supervisor.start()
  const emit = (event: ConnectionEvent): void => {
    if (event.type === 'disconnected') connection.state = 'disconnected'
    for (const listener of [...listeners]) listener(event)
  }
  return { supervisor, scheduler, connection, events, calls, emit }
}

describe('ReconnectSupervisor', () => {
  it('tells the agent, waits 5 seconds, and rejoins the same world', async () => {
    const s = setup(3, [ok({})])

    s.emit({ type: 'disconnected', reason: 'socketClosed' })

    expect(s.events.map((e) => e.type)).toEqual(['reconnecting'])
    expect(s.events[0]?.message).toContain('socketClosed')
    expect(await s.scheduler.fire()).toBe(5_000)
    expect(s.calls).toEqual([{ host: 'localhost', port: 25565 }])
    expect(s.events.map((e) => e.type)).toEqual(['reconnecting', 'reconnected'])
    expect(s.events[1]?.message).toContain('get_session_briefing')
    expect(s.scheduler.live()).toBe(0)
  })

  it('says it is reconnecting from the loss until it is back or gives up', async () => {
    const s = setup(2)
    expect(s.supervisor.reconnecting).toBe(false)

    s.emit({ type: 'disconnected', reason: 'socketClosed' })
    expect(s.supervisor.reconnecting).toBe(true)
    await s.scheduler.fire()
    expect(s.supervisor.reconnecting).toBe(true) // a second try is waiting
    await s.scheduler.fire()
    expect(s.supervisor.reconnecting).toBe(false) // gave up
  })

  it('backs off between failed attempts, then gives up and tells the agent what to do', async () => {
    const s = setup(3)

    s.emit({ type: 'disconnected', reason: 'socketClosed' })
    const waits = [await s.scheduler.fire(), await s.scheduler.fire(), await s.scheduler.fire()]

    expect(waits).toEqual([5_000, 10_000, 20_000])
    expect(s.calls).toHaveLength(3)
    expect(s.events.map((e) => e.type)).toEqual(['reconnecting', 'reconnect_failed'])
    expect(s.events[1]?.message).toContain('call connect')
    expect(s.scheduler.live()).toBe(0)
  })

  it('does not rejoin after a disconnect the agent asked for', () => {
    const s = setup(3)

    s.emit({ type: 'disconnected', reason: 'Disconnected by request', intentional: true })

    expect(s.events).toEqual([])
    expect(s.scheduler.live()).toBe(0)
  })

  it('does not rejoin after a kick (a ban or a whitelist would only repeat)', () => {
    const s = setup(3)

    s.emit({ type: 'kicked', reason: 'You are banned' })
    s.emit({ type: 'disconnected', reason: 'You are banned' })

    expect(s.events).toEqual([])
    expect(s.scheduler.live()).toBe(0)
  })

  it('forgets a kick once the bot is back, so the next lost connection is retried', () => {
    const s = setup(3)
    s.emit({ type: 'kicked', reason: 'restart' })
    s.emit({ type: 'disconnected', reason: 'restart' })
    s.emit({ type: 'connected', username: 'Bot' })

    s.emit({ type: 'disconnected', reason: 'socketClosed' })

    expect(s.events.map((e) => e.type)).toEqual(['reconnecting'])
  })

  it('stops when somebody connects by hand', async () => {
    const s = setup(3)
    s.emit({ type: 'disconnected', reason: 'socketClosed' })

    s.emit({ type: 'connected', username: 'Bot' })

    expect(s.scheduler.live()).toBe(0)
    expect(await s.scheduler.fire()).toBeUndefined()
  })

  it('does nothing when it is switched off, and stops at dispose', () => {
    const off = setup(0)
    off.emit({ type: 'disconnected', reason: 'socketClosed' })
    expect(off.events).toEqual([])

    const s = setup(3)
    s.emit({ type: 'disconnected', reason: 'socketClosed' })
    s.supervisor.dispose()
    expect(s.scheduler.live()).toBe(0)
    s.emit({ type: 'disconnected', reason: 'again' })
    expect(s.events.map((e) => e.type)).toEqual(['reconnecting'])
  })

  it('skips an attempt when the bot is connected already, and when there is no target', async () => {
    const s = setup(3)
    s.emit({ type: 'disconnected', reason: 'socketClosed' })
    s.connection.state = 'connected'
    await s.scheduler.fire()
    expect(s.calls).toEqual([])

    const none = setup(3)
    none.connection.target = undefined
    none.emit({ type: 'disconnected', reason: 'socketClosed' })
    expect(none.events).toEqual([])
  })
})
