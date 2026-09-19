import { Rcon } from 'rcon-client'
import type { Position } from '../../../src/core/position.types.js'
import type { ServerInfo } from './server-config.js'

/** Superflat world: bedrock at -64, dirt at -63 and -62, grass at -61; players stand at y = -60. */
export const GROUND_Y = -60
const FLOOR_Y = GROUND_Y - 1

const ERROR_RESPONSE =
  /^(Unknown|Incorrect|Expected|That position|No entity was found|Could not|Invalid)/i

const at = (p: Position): string =>
  `${String(Math.floor(p.x))} ${String(Math.floor(p.y))} ${String(Math.floor(p.z))}`

/** Sets up and inspects the e2e world through the server console (RCON). */
export class E2EWorld {
  private constructor(private readonly rcon: Rcon) {}

  static async connect(info: ServerInfo): Promise<E2EWorld> {
    const rcon = await Rcon.connect({
      host: info.host,
      port: info.rconPort,
      password: info.rconPassword,
    })
    return new E2EWorld(rcon)
  }

  async close(): Promise<void> {
    await this.rcon.end()
  }

  /** Runs a console command and returns the response. Error responses throw, unless `allowFailure`. */
  async command(command: string, allowFailure = false): Promise<string> {
    const response = await this.rcon.send(command)
    if (!allowFailure && ERROR_RESPONSE.test(response)) {
      throw new Error(`Server rejected "${command}": ${response}`)
    }
    return response
  }

  async onlinePlayers(): Promise<string[]> {
    const response = await this.command('list')
    const names = response.split(':')[1]?.trim() ?? ''
    return names === '' ? [] : names.split(',').map((name) => name.trim())
  }

  async setBlock(position: Position, block: string): Promise<void> {
    await this.command(`setblock ${at(position)} ${block}`)
  }

  async fill(from: Position, to: Position, block: string): Promise<void> {
    await this.command(`fill ${at(from)} ${at(to)} ${block}`)
  }

  /** True when the block at the position is the given block (`execute if block`). */
  async isBlock(position: Position, block: string): Promise<boolean> {
    const response = await this.command(`execute if block ${at(position)} ${block}`, true)
    return response.includes('Test passed')
  }

  /**
   * Prepares a clean, flat, bright arena: loads the chunks, clears everything above the floor,
   * lays a grass floor, and removes all non-player entities.
   */
  async prepareArena(center: Position, radius = 15): Promise<void> {
    const low = { x: Math.floor(center.x) - radius, z: Math.floor(center.z) - radius }
    const high = { x: Math.floor(center.x) + radius, z: Math.floor(center.z) + radius }
    await this.command(
      `forceload add ${String(low.x)} ${String(low.z)} ${String(high.x)} ${String(high.z)}`,
    )
    await this.fill(
      { x: low.x, y: FLOOR_Y, z: low.z },
      { x: high.x, y: FLOOR_Y, z: high.z },
      'grass_block',
    )
    await this.fill(
      { x: low.x, y: GROUND_Y, z: low.z },
      { x: high.x, y: GROUND_Y + 12, z: high.z },
      'air',
    )
    await this.command('kill @e[type=!player]', true)
  }

  async teleport(player: string, position: Position): Promise<void> {
    await this.command(
      `tp ${player} ${String(position.x)} ${String(position.y)} ${String(position.z)}`,
    )
  }

  async playerPosition(player: string): Promise<Position> {
    const response = await this.command(`data get entity ${player} Pos`)
    const match = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(response)
    if (match === null) throw new Error(`Could not read the position of ${player}: ${response}`)
    return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) }
  }

  async give(player: string, item: string, count = 1): Promise<void> {
    await this.command(`give ${player} ${item} ${String(count)}`)
  }

  /** How many of the item the player carries (`clear ... 0` counts without removing). */
  async countItem(player: string, item: string): Promise<number> {
    const response = await this.command(`clear ${player} ${item} 0`, true)
    return Number(/Found (\d+) matching item/.exec(response)?.[1] ?? 0)
  }

  async clearInventory(player: string): Promise<void> {
    await this.command(`clear ${player}`, true)
  }

  async summon(entity: string, position: Position): Promise<void> {
    await this.command(
      `summon ${entity} ${String(position.x)} ${String(position.y)} ${String(position.z)}`,
    )
  }

  async setTime(time: string): Promise<void> {
    await this.command(`time set ${time}`)
  }

  async setGameRule(rule: string, value: boolean | number): Promise<void> {
    await this.command(`gamerule ${rule} ${String(value)}`)
  }

  async setDifficulty(difficulty: 'peaceful' | 'easy' | 'normal' | 'hard'): Promise<void> {
    await this.command(`difficulty ${difficulty}`)
  }
}
