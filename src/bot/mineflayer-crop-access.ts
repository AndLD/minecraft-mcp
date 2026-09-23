import type { CropAccess, CropState } from '../core/crop.port.js'
import type { Position } from '../core/position.types.js'
import type { BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

export class MineflayerCropAccess implements CropAccess {
  constructor(private readonly holder: BotHolder) {}

  stateAt(position: Position): CropState | undefined {
    const block = this.holder.current()?.blockAt(toVec3(position))
    if (block === null || block === undefined) return undefined
    const raw = block.getProperties?.()['age']
    // Mineflayer reports this blockstate property as a numeric string ("7"), not a number, unlike the booleans
    // doors and switches carry (found running this feature's own e2e test against a real server).
    const age = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    if (!Number.isFinite(age)) return undefined
    return { name: block.name, age }
  }
}
