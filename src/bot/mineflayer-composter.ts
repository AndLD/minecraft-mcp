import type { ComposterAccess } from '../core/composter.port.js'
import type { Position } from '../core/position.types.js'
import type { BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

export class MineflayerComposterAccess implements ComposterAccess {
  constructor(private readonly holder: BotHolder) {}

  levelAt(position: Position): number | undefined {
    const block = this.holder.current()?.blockAt(toVec3(position))
    if (block === null || block === undefined || block.name !== 'composter') return undefined
    const raw = block.getProperties?.()['level']
    // Numeric string on a real server, like the crop `age`.
    const level = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    return Number.isFinite(level) ? level : undefined
  }
}
