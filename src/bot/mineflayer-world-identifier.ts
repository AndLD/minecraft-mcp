import type { ConnectTarget } from '../core/connection.port.js'
import type { ServerStatusProbe } from '../core/server-status.port.js'
import type { WorldFingerprint, WorldIdentifier } from '../core/world-identifier.port.js'
import type { BotHolder } from './bot-like.types.js'
import { splitMotd } from './motd.js'

/** Reads the world's fingerprint from the connected bot (seed, spawn point) and the server status (name). */
export class MineflayerWorldIdentifier implements WorldIdentifier {
  constructor(
    private readonly holder: BotHolder,
    private readonly probe: ServerStatusProbe,
  ) {}

  async identify(target: ConnectTarget, worldNameHint?: string): Promise<WorldFingerprint> {
    const bot = this.holder.current()
    const spawn = bot?.spawnPoint
    // The spawn point is (0, 0, 0) until the server sends it; a real spawn is never at height 0.
    const spawnKnown = spawn !== undefined && !(spawn.x === 0 && spawn.y === 0 && spawn.z === 0)

    let worldName: string | null = worldNameHint ?? null
    if (worldName === null) {
      const status = await this.probe.probe(target.host, target.port)
      worldName = status === undefined ? null : splitMotd(status.motd).worldName || null
    }
    return {
      seed: bot?.worldSeed ?? null,
      worldName,
      spawn: spawnKnown ? { x: spawn.x, y: spawn.y, z: spawn.z } : null,
    }
  }
}
