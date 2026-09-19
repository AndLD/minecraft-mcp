import { describe, expect, it, jest } from '@jest/globals'
import { AgentInbox } from '../../../src/chat/agent-inbox.js'
import { ChatRouter } from '../../../src/chat/chat-router.js'
import { StopCommand } from '../../../src/chat/stop-command.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { FakeLogger } from '../../fakes/fake-logger.js'
import { FakeScheduler } from '../../fakes/fake-scheduler.js'

function setup(owner: string | undefined) {
  const clock = new FakeClock(0)
  const inbox = new AgentInbox({ clock, scheduler: new FakeScheduler(clock) })
  const stopAll = jest.fn()
  const router = new ChatRouter({
    inbox,
    logger: new FakeLogger(),
    owner,
    commands: [new StopCommand({ stopAll })],
  })
  return { inbox, router, stopAll }
}

describe('ChatRouter', () => {
  it('forwards the owner chat to the agent inbox', () => {
    const { inbox, router } = setup('Andrey_Knight')

    router.handle({ sender: 'Andrey_Knight', text: 'build a house', whisper: false })

    expect(inbox.drain().messages.map((m) => m.text)).toEqual(['build a house'])
  })

  it('matches the owner name case-insensitively', () => {
    const { inbox, router } = setup('Andrey_Knight')

    router.handle({ sender: 'andrey_knight', text: 'hi', whisper: false })

    expect(inbox.pendingCount).toBe(1)
  })

  it('ignores other players when an owner is configured', () => {
    const { inbox, router, stopAll } = setup('Andrey_Knight')

    router.handle({ sender: 'Stranger', text: 'stop', whisper: false })
    router.handle({ sender: 'Stranger', text: 'give me diamonds', whisper: true })

    expect(inbox.pendingCount).toBe(0)
    expect(stopAll).not.toHaveBeenCalled()
  })

  it('accepts everyone when no owner is configured', () => {
    const { inbox, router } = setup(undefined)

    router.handle({ sender: 'Anyone', text: 'hello', whisper: false })

    expect(inbox.pendingCount).toBe(1)
  })

  it('keeps the whisper flag', () => {
    const { inbox, router } = setup(undefined)

    router.handle({ sender: 'A', text: 'psst', whisper: true })

    expect(inbox.drain().messages[0]?.whisper).toBe(true)
  })

  it('runs the stop command in code and tells the agent through an event, not chat', () => {
    const { inbox, router, stopAll } = setup('Andrey_Knight')

    router.handle({ sender: 'Andrey_Knight', text: 'stop', whisper: false })

    expect(stopAll).toHaveBeenCalledTimes(1)
    const batch = inbox.drain()
    expect(batch.messages).toEqual([])
    expect(batch.events.map((e) => e.type)).toEqual(['command'])
  })
})
