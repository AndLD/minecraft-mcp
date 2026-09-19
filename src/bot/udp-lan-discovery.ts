import type { DatagramSocketFactory } from '../core/datagram-socket.port.js'
import type { LanDiscovery, LanDiscoveryOptions, LanWorld } from '../core/lan-discovery.port.js'
import type { Scheduler } from '../core/scheduler.port.js'

export const LAN_MULTICAST_ADDRESS = '224.0.2.60'
export const LAN_MULTICAST_PORT = 4445

/**
 * A LAN world announces itself as `[MOTD]<player> - <world name>[/MOTD][AD]<port>[/AD]`.
 * Returns undefined when the text is not an announcement.
 */
export function parseLanAnnouncement(text: string): LanWorld | undefined {
  const motd = /\[MOTD\](.*?)\[\/MOTD\]/s.exec(text)?.[1]
  const portText = /\[AD\](\d+)\[\/AD\]/.exec(text)?.[1]
  if (motd === undefined || portText === undefined) return undefined
  const port = Number(portText)
  if (port < 1 || port > 65535) return undefined

  const separator = motd.indexOf(' - ')
  if (separator < 0) return { port, worldName: motd.trim(), hostPlayer: undefined }
  return {
    port,
    hostPlayer: motd.slice(0, separator).trim(),
    worldName: motd.slice(separator + 3).trim(),
  }
}

export class UdpLanDiscovery implements LanDiscovery {
  constructor(
    private readonly createSocket: DatagramSocketFactory,
    private readonly scheduler: Scheduler,
  ) {}

  discover(options: LanDiscoveryOptions): Promise<LanWorld | undefined> {
    return new Promise<LanWorld | undefined>((resolve) => {
      const socket = this.createSocket()
      const preferred = options.preferHostPlayer?.toLowerCase()
      let firstSeen: LanWorld | undefined
      let finished = false
      let cancelTimer = (): void => undefined

      const finish = (world: LanWorld | undefined): void => {
        if (finished) return
        finished = true
        cancelTimer()
        try {
          socket.close()
        } catch {
          // Already closed.
        }
        resolve(world)
      }

      socket.on('message', (data) => {
        const world = parseLanAnnouncement(Buffer.from(data).toString('utf8'))
        if (world === undefined) return
        firstSeen ??= world
        if (preferred === undefined || world.hostPlayer?.toLowerCase() === preferred) finish(world)
      })
      socket.on('error', () => {
        finish(firstSeen)
      })
      cancelTimer = this.scheduler.after(options.timeoutMs, () => {
        finish(firstSeen)
      })
      socket.bind(LAN_MULTICAST_PORT, () => {
        try {
          socket.addMembership(LAN_MULTICAST_ADDRESS)
        } catch {
          finish(firstSeen)
        }
      })
    })
  }
}
