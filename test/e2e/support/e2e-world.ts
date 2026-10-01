import { Rcon } from 'rcon-client'
import type { Position } from '../../../src/core/position.types.js'
import type { ServerInfo } from './server-config.js'
import { pause, waitUntil } from './wait.js'

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
  /** Puts a stack in a chest slot, for example `fillSlot(pos, 0, 'iron_ingot', 20)`. */
  async fillSlot(position: Position, slot: number, item: string, count: number): Promise<void> {
    await this.command(
      `item replace block ${at(position)} container.${String(slot)} with minecraft:${item} ${String(count)}`,
    )
  }

  /**
   * How many of an item a chest (or barrel) holds. Reads one slot at a time: the server cuts a long block-data reply
   * short, so `data get block ... Items` cannot be trusted for a full chest.
   */
  async countInChest(position: Position, item: string, slots = 27): Promise<number> {
    let total = 0
    for (let slot = 0; slot < slots; slot += 1) {
      const response = await this.command(
        `data get block ${at(position)} Items[{Slot:${String(slot)}b}]`,
        true,
      )
      if (!response.includes(`"minecraft:${item}"`)) continue
      total += Number(/count: (\d+)/.exec(response)?.[1] ?? 0)
    }
    return total
  }

  /** Turns a player to look in a direction (degrees; yaw 0 faces +z, 90 faces -x; pitch 90 looks down). */
  async face(player: string, position: Position, yaw: number, pitch: number): Promise<void> {
    await this.command(
      `tp ${player} ${String(position.x)} ${String(position.y)} ${String(position.z)} ${String(yaw)} ${String(pitch)}`,
    )
  }

  async isBlock(position: Position, block: string): Promise<boolean> {
    const response = await this.command(`execute if block ${at(position)} ${block}`, true)
    return response.includes('Test passed')
  }

  /**
   * Prepares a clean, flat, bright arena: loads the chunks, clears everything above the floor,
   * and lays a grass floor. Entities are cleared separately (`clearEntities`), once a player is online.
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
  }

  /**
   * Removes every non-player entity (again and again, since dying mobs drop items) and waits until they are really gone. A player must be online while this runs:
   * the server does not tick entities that have no player nearby, so a killed mob would keep its death animation
   * (and a bot joining later would see it as a live threat).
   */
  async clearEntities(): Promise<void> {
    const killed = { anything: false } // set inside the polling closure below
    try {
      // Dying mobs drop items after the kill, so keep killing until nothing is left.
      await waitUntil(
        async () => {
          if (!(await this.entityExists('@e[type=!player]'))) return true
          await this.command('kill @e[type=!player]', true)
          killed.anything = true
          return undefined
        },
        { description: 'the killed entities to be gone' },
      )
      // Selectors already skip a mob that is dying, but it stays visible for its one-second death animation.
      if (killed.anything) await pause(1500)
    } catch (error) {
      const left = await this.command('data get entity @e[type=!player,limit=1]', true)
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}. An entity is still there: ${left.slice(0, 600)}`,
        {
          cause: error,
        },
      )
    }
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

  /** Summons an entity with NBT data, for example `{NoAI:1b}` (a mob that stands still). */
  async summonWith(entity: string, position: Position, nbt: string): Promise<void> {
    await this.command(
      `summon ${entity} ${String(position.x)} ${String(position.y)} ${String(position.z)} ${nbt}`,
    )
  }

  /** True when at least one entity matches the selector, for example `@e[type=zombie]`. */
  async entityExists(selector: string): Promise<boolean> {
    return (await this.command(`execute if entity ${selector}`, true)).includes('Test passed')
  }

  /** How many entities match the selector, for example `@e[type=cow]`. */
  async countEntities(selector: string): Promise<number> {
    const response = await this.command(`execute if entity ${selector}`, true)
    if (!response.includes('Test passed')) return 0
    return Number(/count: (\d+)/.exec(response)?.[1] ?? 1)
  }

  async damage(player: string, amount: number): Promise<void> {
    await this.command(`damage ${player} ${String(amount)} minecraft:generic`)
  }

  async giveEffect(
    player: string,
    effect: string,
    seconds: number,
    amplifier: number,
  ): Promise<void> {
    await this.command(
      `effect give ${player} minecraft:${effect} ${String(seconds)} ${String(amplifier)} true`,
    )
  }

  async clearEffects(player: string): Promise<void> {
    await this.command(`effect clear ${player}`, true)
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
