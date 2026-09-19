import type { DroppedItem, DroppedItemScanner } from '../core/dropped-items.port.js'
import { distanceBetween } from '../core/position.js'
import type { BotHolder } from './bot-like.types.js'

export class MineflayerDroppedItems implements DroppedItemScanner {
  constructor(private readonly holder: BotHolder) {}

  nearby(maxDistance: number): readonly DroppedItem[] {
    const bot = this.holder.current()
    const origin = bot?.entity?.position
    if (bot === undefined || origin === undefined) return []

    const found: DroppedItem[] = []
    for (const entity of Object.values(bot.entities)) {
      if (entity.name !== 'item' || entity.isValid === false) continue
      const stack = entity.getDroppedItem?.()
      if (stack === undefined || stack === null) continue // the item's data has not arrived yet
      const distance = distanceBetween(origin, entity.position)
      if (distance > maxDistance) continue
      found.push({
        entityId: entity.id,
        name: stack.name,
        count: stack.count,
        position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        distance,
      })
    }
    return found.sort((a, b) => a.distance - b.distance)
  }
}
