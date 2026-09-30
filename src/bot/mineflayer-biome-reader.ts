import type { BiomeReader } from '../core/biome.port.js'
import type { Position } from '../core/position.types.js'
import type { BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

/** Some game data keys biomes as `minecraft:desert`; the rest of the code uses `desert`. */
const plain = (name: string): string => name.replace(/^minecraft:/, '')

export class MineflayerBiomeReader implements BiomeReader {
  constructor(private readonly holder: BotHolder) {}

  biomeAt(position: Position): string | undefined {
    const bot = this.holder.current()
    const biome = bot?.blockAt(toVec3(position))?.biome
    if (bot === undefined || biome === undefined) return undefined
    // The block's own biome object often has no name (it was built without the version's data): use the id.
    const name = bot.registry.biomes?.[biome.id]?.name ?? biome.name
    return name === undefined || name === '' ? undefined : plain(name)
  }

  knownBiomeNames(): readonly string[] {
    return Object.keys(this.holder.current()?.registry.biomesByName ?? {}).map(plain)
  }
}
