import type { EntityInfo, EntityScanner, PlayerInfo } from '../core/entity-scanner.port.js'
import { distanceBetween } from '../core/position.js'
import type { BotHolder } from './bot-like.types.js'

export class MineflayerEntityScanner implements EntityScanner {
  constructor(private readonly holder: BotHolder) {}

  nearby(maxDistance: number): readonly EntityInfo[] {
    const bot = this.holder.current()
    const origin = bot?.entity?.position
    if (bot === undefined || origin === undefined) return []

    const found: EntityInfo[] = []
    for (const entity of Object.values(bot.entities)) {
      const distance = distanceBetween(origin, entity.position)
      if (distance === 0 || distance > maxDistance) continue // distance 0 is the bot itself
      found.push({
        id: entity.id,
        category: entity.type,
        name: entity.username ?? entity.name ?? entity.type,
        position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        distance,
      })
    }
    return found.sort((a, b) => a.distance - b.distance)
  }

  player(name: string): PlayerInfo | undefined {
    const bot = this.holder.current()
    if (bot === undefined) return undefined
    const wanted = name.toLowerCase()
    const player = Object.values(bot.players).find((p) => p.username.toLowerCase() === wanted)
    if (player === undefined) return undefined

    const origin = bot.entity?.position
    const position = player.entity?.position
    return {
      name: player.username,
      online: true,
      position:
        position === undefined ? undefined : { x: position.x, y: position.y, z: position.z },
      distance:
        origin === undefined || position === undefined
          ? undefined
          : distanceBetween(origin, position),
    }
  }
}
