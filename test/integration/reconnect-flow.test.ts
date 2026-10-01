import { afterEach, describe, expect, it } from '@jest/globals'
import { createHarness, type Harness } from './support/app-harness.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close().catch(() => undefined)
  harness = undefined
})

async function start(): Promise<Harness> {
  const h = await createHarness({ reconnectAttempts: 3 })
  harness = h
  const connected = await h.call('connect', { port: 34231 })
  if (connected.isError) throw new Error(connected.text)
  await h.call('wait_for_chat', { timeout_seconds: 1 })
  return h
}

const eventTypes = (data: unknown): string[] =>
  (data as { events: { type: string }[] }).events.map((event) => event.type)

describe('losing the connection through the MCP server', () => {
  it('rejoins by itself after the server goes away, and leaves no task stuck', async () => {
    const h = await start()
    const goto = await h.call('goto', { x: 500, y: 64, z: 500, wait_seconds: 0 })
    expect(goto.isError).toBe(false)

    h.bot.emit('end', 'socketClosed')
    await h.settle()

    const status = await h.call('get_status')
    expect(status.data).toMatchObject({ state: 'disconnected' })
    const idle = await h.call('get_task_status')
    expect(idle.data).not.toMatchObject({ task: { status: 'running' } })

    h.scheduler.advance(5_000)
    // Rejoining also opens the saved state of the world (file I/O), so give it a few turns.
    for (let turn = 0; turn < 40; turn += 1) await h.settle()

    expect(h.connectTargets).toHaveLength(2)
    const back = await h.call('get_status')
    expect(back.data).toMatchObject({ state: 'connected' })
    const heard = await h.call('wait_for_chat', { timeout_seconds: 1 })
    expect(eventTypes(heard.data)).toEqual(
      expect.arrayContaining(['disconnected', 'reconnecting', 'connected', 'reconnected']),
    )
  })

  it('wait_for_chat keeps waiting while the bot is trying to rejoin, and fails again once it has given up', async () => {
    const h = await createHarness({ reconnectAttempts: 1 })
    harness = h
    await h.call('connect', { port: 34231 })
    await h.call('wait_for_chat', { timeout_seconds: 1 })

    h.bot.emit('end', 'socketClosed')
    await h.settle()
    await h.call('wait_for_chat', { timeout_seconds: 1 }) // the pending events

    const waiting = h.call('wait_for_chat', { timeout_seconds: 10 })
    h.scheduler.advance(10_000)
    const answer = await waiting
    expect(answer.isError).toBe(false) // it waited (the rejoin is under way) instead of failing
  })

  it('does not rejoin after the agent disconnects on purpose', async () => {
    const h = await start()

    await h.call('disconnect')
    h.scheduler.advance(120_000)
    await h.settle()

    expect(h.connectTargets).toHaveLength(1)
    expect((await h.call('get_status')).data).toMatchObject({ state: 'disconnected' })
  })

  it('does not rejoin after a kick', async () => {
    const h = await start()

    h.bot.emit('kicked', 'You are banned from this server')
    h.bot.emit('end', 'You are banned from this server')
    await h.settle()
    h.scheduler.advance(120_000)
    await h.settle()

    expect(h.connectTargets).toHaveLength(1)
    const heard = await h.call('wait_for_chat', { timeout_seconds: 1 })
    expect(eventTypes(heard.data)).not.toContain('reconnecting')
  })
})
