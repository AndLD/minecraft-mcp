import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerBiomeReader } from '../../../src/bot/mineflayer-biome-reader.js'
import { MineflayerEntityScanner } from '../../../src/bot/mineflayer-entity-scanner.js'
import { FakeBot } from '../../fakes/fake-bot.js'

const holderOf = (bot: unknown): BotHolder => ({
  current: () => bot as BotLike | undefined,
  onChange: () => () => undefined,
})

describe('MineflayerBiomeReader', () => {
  it('reads the biome of the block the world reports, and the biome names of the game', () => {
    const bot = {
      blockAt: () => ({ name: 'grass_block', biome: { id: 14, name: '' } }),
      registry: {
        biomesByName: { 'minecraft:desert': {}, plains: {} },
        biomes: { 14: { name: 'minecraft:desert' } },
      },
    }
    const reader = new MineflayerBiomeReader(holderOf(bot))

    expect(reader.biomeAt({ x: 1, y: 64, z: 2 })).toBe('desert')
    expect(reader.knownBiomeNames()).toEqual(['desert', 'plains'])
  })

  it('falls back to the name the block carries, and gives none when there is no name at all', () => {
    const named = new MineflayerBiomeReader(
      holderOf({
        blockAt: () => ({ name: 'stone', biome: { id: 7, name: 'plains' } }),
        registry: {},
      }),
    )
    const nameless = new MineflayerBiomeReader(
      holderOf({ blockAt: () => ({ name: 'stone', biome: { id: 7, name: '' } }), registry: {} }),
    )

    expect(named.biomeAt({ x: 0, y: 0, z: 0 })).toBe('plains')
    expect(nameless.biomeAt({ x: 0, y: 0, z: 0 })).toBeUndefined()
  })

  it('knows nothing for an unloaded block, a version without biomes, or no bot', () => {
    const unloaded = new MineflayerBiomeReader(holderOf({ blockAt: () => null, registry: {} }))
    const none = new MineflayerBiomeReader(holderOf(undefined))

    expect(unloaded.biomeAt({ x: 0, y: 0, z: 0 })).toBeUndefined()
    expect(unloaded.knownBiomeNames()).toEqual([])
    expect(none.biomeAt({ x: 0, y: 0, z: 0 })).toBeUndefined()
    expect(none.knownBiomeNames()).toEqual([])
  })
})

describe('MineflayerEntityScanner.knownEntityNames', () => {
  it('lists the entity types of the game, and nothing without a bot', () => {
    const scanner = new MineflayerEntityScanner(holderOf(new FakeBot()))

    expect(scanner.knownEntityNames()).toEqual(expect.arrayContaining(['sheep', 'cow']))
    expect(new MineflayerEntityScanner(holderOf(undefined)).knownEntityNames()).toEqual([])
  })
})
