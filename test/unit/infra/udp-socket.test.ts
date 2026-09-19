import { describe, expect, it } from '@jest/globals'
import { createUdpSocket } from '../../../src/infra/udp-socket.js'

describe('createUdpSocket', () => {
  it('creates a socket that can be closed', () => {
    const socket = createUdpSocket()

    expect(() => socket.close()).not.toThrow()
  })
})
