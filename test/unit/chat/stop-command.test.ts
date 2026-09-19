import { describe, expect, it, jest } from '@jest/globals'
import { StopCommand } from '../../../src/chat/stop-command.js'

describe('StopCommand', () => {
  const command = new StopCommand({ stopAll: jest.fn() })

  it.each(['stop', 'Stop', 'STOP', ' stop ', '!stop', 'stop!', 'stop.'])('matches %j', (text) => {
    expect(command.matches({ text })).toBe(true)
  })

  it.each(['stop mining', 'please stop', 'stopping', 'do not stop', '', 'unstoppable'])(
    'does not match %j',
    (text) => {
      expect(command.matches({ text })).toBe(false)
    },
  )

  it('cancels everything through the handler and reports it', () => {
    const stopAll = jest.fn()
    const note = new StopCommand({ stopAll }).execute()

    expect(stopAll).toHaveBeenCalledTimes(1)
    expect(note).toContain('stop')
  })
})
