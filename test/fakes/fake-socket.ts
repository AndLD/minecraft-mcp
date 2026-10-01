import type { DatagramSocket } from '../../src/core/datagram-socket.port.js'

/** A stub UDP socket: tests push datagrams into it. */
export class FakeSocket implements DatagramSocket {
  closed = false
  boundPort: number | undefined
  membership: string | undefined
  failMembership = false
  private messageListeners: ((message: Uint8Array) => void)[] = []
  private errorListeners: ((error: Error) => void)[] = []

  on(event: 'message', listener: (message: Uint8Array) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(
    event: 'message' | 'error',
    listener: ((message: Uint8Array) => void) | ((error: Error) => void),
  ): unknown {
    if (event === 'message') this.messageListeners.push(listener as (message: Uint8Array) => void)
    else this.errorListeners.push(listener as (error: Error) => void)
    return this
  }

  bind(port: number, callback: () => void): unknown {
    this.boundPort = port
    callback()
    return this
  }

  addMembership(address: string): unknown {
    if (this.failMembership) throw new Error('no multicast')
    this.membership = address
    return this
  }

  close(): unknown {
    this.closed = true
    return this
  }

  receive(text: string): void {
    for (const listener of this.messageListeners) listener(Buffer.from(text, 'utf8'))
  }

  fail(error: Error): void {
    for (const listener of this.errorListeners) listener(error)
  }
}

export const announcement = (motd: string, port: number): string =>
  `[MOTD]${motd}[/MOTD][AD]${String(port)}[/AD]`
