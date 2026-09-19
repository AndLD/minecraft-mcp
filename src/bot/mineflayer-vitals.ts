import type { Vitals, VitalsReader } from '../core/vitals.port.js'
import type { BotHolder } from './bot-like.types.js'

export class MineflayerVitals implements VitalsReader {
  constructor(private readonly holder: BotHolder) {}

  read(): Vitals | undefined {
    const bot = this.holder.current()
    const position = bot?.entity?.position
    if (bot === undefined || position === undefined) return undefined
    return {
      health: bot.health,
      food: bot.food,
      position: { x: position.x, y: position.y, z: position.z },
      dimension: bot.game.dimension,
      timeOfDay: bot.time.timeOfDay,
    }
  }
}
