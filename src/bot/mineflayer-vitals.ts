import { Vec3 } from 'vec3'
import type { Vitals, VitalsReader } from '../core/vitals.port.js'
import type { BotHolder } from './bot-like.types.js'

/** How far above the feet the eyes are, in blocks. */
const EYE_HEIGHT = 1.62

export class MineflayerVitals implements VitalsReader {
  constructor(private readonly holder: BotHolder) {}

  read(): Vitals | undefined {
    const bot = this.holder.current()
    const position = bot?.entity?.position
    if (bot === undefined || position === undefined) return undefined

    const at = (heightAboveFeet: number): string | undefined =>
      bot.blockAt(new Vec3(position.x, position.y + heightAboveFeet, position.z))?.name
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
