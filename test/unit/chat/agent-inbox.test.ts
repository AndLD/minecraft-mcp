import { describe, expect, it } from '@jest/globals'
import { AgentInbox } from '../../../src/chat/agent-inbox.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { FakeScheduler } from '../../fakes/fake-scheduler.js'

function setup(capacity?: number) {
  const clock = new FakeClock(1000)
  const scheduler = new FakeScheduler(clock)
  const inbox = new AgentInbox({
    clock,
    scheduler,
    ...(capacity === undefined ? {} : { capacity }),
  })
  return { clock, scheduler, inbox }
}

const chat = (text: string, sender = 'Andrey_Knight') => ({ sender, text, whisper: false })

describe('AgentInbox', () => {
  it('stamps messages and events with the clock', () => {
    const { inbox } = setup()
    inbox.pushMessage(chat('hi'))
    inbox.pushEvent({ type: 'connected', message: 'joined' })

    const batch = inbox.drain()

    expect(batch.messages).toEqual([
      { sender: 'Andrey_Knight', text: 'hi', whisper: false, receivedAt: 1000 },
    ])
    expect(batch.events).toEqual([{ type: 'connected', message: 'joined', at: 1000 }])
  })

  it('delivers each item only once', () => {
    const { inbox } = setup()
    inbox.pushMessage(chat('one'))
    expect(inbox.pendingCount).toBe(1)

    expect(inbox.drain().messages).toHaveLength(1)
    expect(inbox.drain().messages).toHaveLength(0)
    expect(inbox.pendingCount).toBe(0)
  })

  it('drops the oldest items past capacity and reports how many', () => {
    const { inbox } = setup(2)
    inbox.pushMessage(chat('1'))
    inbox.pushMessage(chat('2'))
    inbox.pushMessage(chat('3'))
    inbox.pushEvent({ type: 'a', message: '1' })
    inbox.pushEvent({ type: 'a', message: '2' })
    inbox.pushEvent({ type: 'a', message: '3' })

    const batch = inbox.drain()

    expect(batch.messages.map((m) => m.text)).toEqual(['2', '3'])
    expect(batch.events.map((e) => e.message)).toEqual(['2', '3'])
    expect(batch.dropped).toBe(2)
    expect(inbox.drain().dropped).toBe(0)
  })

  describe('wait', () => {
    it('returns immediately when something is already buffered', async () => {
      const { inbox, scheduler } = setup()
      inbox.pushMessage(chat('waiting'))

      const result = await inbox.wait(30_000)

      expect(result.timedOut).toBe(false)
      expect(result.messages.map((m) => m.text)).toEqual(['waiting'])
      expect(scheduler.pendingCount).toBe(0)
    })

    it('resolves as soon as a message arrives', async () => {
      const { inbox, scheduler } = setup()
      const pending = inbox.wait(30_000)

      inbox.pushMessage(chat('hello'))
      const result = await pending

      expect(result.timedOut).toBe(false)
      expect(result.messages.map((m) => m.text)).toEqual(['hello'])
      expect(scheduler.pendingCount).toBe(0)
    })

    it('resolves when an event arrives', async () => {
      const { inbox } = setup()
      const pending = inbox.wait(30_000)

      inbox.pushEvent({ type: 'kicked', message: 'bye' })
      const result = await pending

      expect(result.events.map((e) => e.type)).toEqual(['kicked'])
      expect(result.timedOut).toBe(false)
    })

    it('times out with an empty result', async () => {
      const { inbox, scheduler } = setup()
      const pending = inbox.wait(30_000)

      scheduler.advance(30_000)
      const result = await pending

      expect(result).toEqual({ messages: [], events: [], dropped: 0, timedOut: true })
    })

    it('gives the next batch to the earliest of several waiters', async () => {
      const { inbox, scheduler } = setup()
      const first = inbox.wait(30_000)
      const second = inbox.wait(30_000)

      inbox.pushMessage(chat('only one'))

      expect((await first).messages).toHaveLength(1)
      scheduler.advance(30_000)
      expect((await second).timedOut).toBe(true)
    })

    it('ends early when aborted', async () => {
      const { inbox, scheduler } = setup()
      const controller = new AbortController()
      const pending = inbox.wait(30_000, controller.signal)

      controller.abort()
      const result = await pending

      expect(result.timedOut).toBe(true)
      expect(scheduler.pendingCount).toBe(0)
    })

    it('returns at once when the signal is already aborted', async () => {
      const { inbox } = setup()
      const controller = new AbortController()
      controller.abort()

      expect((await inbox.wait(30_000, controller.signal)).timedOut).toBe(true)
    })

    it('does not lose a message that arrives after an earlier waiter timed out', async () => {
      const { inbox, scheduler } = setup()
      const pending = inbox.wait(1000)
      scheduler.advance(1000)
      await pending

      inbox.pushMessage(chat('late'))

      expect((await inbox.wait(1000)).messages.map((m) => m.text)).toEqual(['late'])
    })
  })
})
