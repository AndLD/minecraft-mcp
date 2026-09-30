import type { HiveAccess, HiveState } from '../core/hive.port.js'
import type { Position } from '../core/position.types.js'
import type { BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

export class MineflayerHiveAccess implements HiveAccess {
  constructor(private readonly holder: BotHolder) {}

  stateAt(position: Position): HiveState | undefined {
    const block = this.holder.current()?.blockAt(toVec3(position))
    if (block === null || block === undefined) return undefined
    if (block.name !== 'beehive' && block.name !== 'bee_nest') return undefined
    const raw = block.getProperties?.()['honey_level']
    // A numeric string on a real server, like a crop's `age`.
    const level = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    return {
      kind: block.name === 'beehive' ? 'hive' : 'nest',
      honeyLevel: Number.isFinite(level) ? level : 0,
    }
  }
}
