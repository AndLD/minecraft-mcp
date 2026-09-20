import type { LightReader } from '../core/light-reader.port.js'
import type { Position } from '../core/position.types.js'
import type { BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

export class MineflayerLightReader implements LightReader {
  constructor(private readonly holder: BotHolder) {}

  blockLightAt(position: Position): number | undefined {
    const block = this.holder.current()?.blockAt(toVec3(position))
    return block?.light ?? undefined
  }
}
