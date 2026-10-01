import { EYE_HEIGHT } from '../core/reach.js'
import type { Vitals, VitalsReader } from '../core/vitals.port.js'
import type { BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

export class MineflayerVitals implements VitalsReader {
  constructor(private readonly holder: BotHolder) {}

  read(): Vitals | undefined {
    const bot = this.holder.current()
    const position = bot?.entity?.position
    if (bot === undefined || position === undefined) return undefined

    const at = (heightAboveFeet: number): string | undefined =>
      bot.blockAt(toVec3({ ...position, y: position.y + heightAboveFeet }))?.name
    const feet = at(0.1)
    const head = at(EYE_HEIGHT)
    return {
      health: bot.health,
      food: bot.food,
      saturation: bot.foodSaturation,
      oxygen: bot.oxygenLevel,
      inLava: feet === 'lava',
      inWater: feet === 'water' || head === 'water',
      headUnderwater: head === 'water',
      position: { x: position.x, y: position.y, z: position.z },
      dimension: bot.game.dimension,
      timeOfDay: bot.time.timeOfDay,
    }
  }
}
