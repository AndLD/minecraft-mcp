/** The part of a UDP socket this adapter needs. */
export interface DatagramSocket {
  on(event: 'message', listener: (message: Uint8Array) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  bind(port: number, callback: () => void): unknown
  addMembership(address: string): unknown
  close(): unknown
}

export type DatagramSocketFactory = () => DatagramSocket
