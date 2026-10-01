import type { Position } from '../core/position.types.js'
import type { RailAccess, RailState } from '../core/rail.port.js'
import type { BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

export class MineflayerRailAccess implements RailAccess {
  constructor(private readonly holder: BotHolder) {}

  stateAt(position: Position): RailState | undefined {
    const block = this.holder.current()?.blockAt(toVec3(position))
    if (block === null || block === undefined || !block.name.endsWith('rail')) return undefined
    const properties = block.getProperties?.() ?? {}
    const shape = properties['shape']
    const powered = properties['powered']
    return {
      name: block.name,
      shape: typeof shape === 'string' ? shape : undefined,
      // Like the other boolean blockstate properties, it may come as a boolean or as "true" / "false".
      powered:
        typeof powered === 'boolean'
          ? powered
          : powered === undefined
            ? undefined
            : powered === 'true',
    }
  }
}
