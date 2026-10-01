import dgram from 'node:dgram'
import type { DatagramSocket } from '../core/datagram-socket.port.js'

/** Real UDP socket for listening to LAN announcements (address reuse lets the game client listen too). */
export function createUdpSocket(): DatagramSocket {
  return dgram.createSocket({ type: 'udp4', reuseAddr: true })
}
