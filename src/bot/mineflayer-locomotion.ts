import type { Locomotion } from '../core/locomotion.port.js'
import type { BotHolder } from './bot-like.types.js'

export class MineflayerLocomotion implements Locomotion {
  constructor(private readonly holder: BotHolder) {}

  setJump(active: boolean): void {
    this.holder.current()?.setControlState('jump', active)
  }
}
