import type { Gaze } from '../core/gaze.port.js'
import type { Position } from '../core/position.types.js'
import type { BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

export class MineflayerGaze implements Gaze {
  constructor(private readonly holder: BotHolder) {}

  async lookAt(target: Position): Promise<void> {
    await this.holder.current()?.lookAt(toVec3(target), true)
  }
}
