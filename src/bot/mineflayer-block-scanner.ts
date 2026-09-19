import { Vec3 } from 'vec3'
import type {
  BlockInfo,
  BlockQuery,
  BlockScanner,
  BlockSummary,
} from '../core/block-scanner.port.js'
import { distanceBetween } from '../core/position.js'
import type { Position } from '../core/position.types.js'
import type { BotHolder } from './bot-like.types.js'

const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air'])

const toVec3 = (position: Position): Vec3 => new Vec3(position.x, position.y, position.z)

export class MineflayerBlockScanner implements BlockScanner {
  constructor(private readonly holder: BotHolder) {}

  knownBlockNames(): readonly string[] {
    const bot = this.holder.current()
    return bot === undefined ? [] : Object.keys(bot.registry.blocksByName)
  }

  findBlocks(query: BlockQuery): readonly BlockInfo[] {
    const bot = this.holder.current()
    const origin = bot?.entity?.position
    if (bot === undefined || origin === undefined) return []

    const ids = query.names
      .map((name) => bot.registry.blocksByName[name]?.id)
      .filter((id): id is number => id !== undefined)
    if (ids.length === 0) return []

    const found: BlockInfo[] = []
    for (const position of bot.findBlocks({
      matching: ids,
      maxDistance: query.maxDistance,
      count: query.count,
    })) {
      const name = bot.blockAt(toVec3(position))?.name
      if (name === undefined) continue
      const plain = { x: position.x, y: position.y, z: position.z }
      found.push({ name, position: plain, distance: distanceBetween(origin, plain) })
    }
    return found.sort((a, b) => a.distance - b.distance)
  }

  blockAt(position: Position): string | undefined {
    return this.holder.current()?.blockAt(toVec3(position))?.name
  }

  sampleBlocks(radius: number): readonly BlockSummary[] {
    const bot = this.holder.current()
    const origin = bot?.entity?.position
    if (bot === undefined || origin === undefined) return []

    const centerX = Math.floor(origin.x)
    const centerY = Math.floor(origin.y)
    const centerZ = Math.floor(origin.z)
    const summaries = new Map<
      string,
      { count: number; nearest: Position; nearestDistance: number }
    >()
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          const position = { x: centerX + dx, y: centerY + dy, z: centerZ + dz }
          const name = bot.blockAt(toVec3(position))?.name
          if (name === undefined || AIR_BLOCKS.has(name)) continue
          const distance = distanceBetween(origin, position)
          const existing = summaries.get(name)
          if (existing === undefined)
            summaries.set(name, { count: 1, nearest: position, nearestDistance: distance })
          else {
            existing.count += 1
            if (distance < existing.nearestDistance) {
              existing.nearest = position
              existing.nearestDistance = distance
            }
          }
        }
      }
    }
    return [...summaries.entries()].map(([name, summary]) => ({ name, ...summary }))
  }
}
