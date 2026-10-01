import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerBucketFiller } from '../../../src/bot/mineflayer-bucket-filler.js'
import { toVec3 } from '../../../src/bot/vec3.js'
import { FakeBot } from '../../fakes/fake-bot.js'

const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})

const source = { x: 3, y: 63, z: 5 }
const signal = (): AbortSignal => new AbortController().signal

function withPool(liquid: 'water' | 'lava' = 'water') {
  const bot = new FakeBot().useGameData()
  bot.entity = { position: { x: 3.5, y: 64, z: 3.5 } }
  bot.setBlock(source, liquid)
  bot.addItems('bucket', 2)
  return bot
}

describe('MineflayerBucketFiller.liquidAt', () => {
  it('tells a source from flowing and falling cells, whether the level is a number or a string', () => {
    const bot = withPool()
    const filler = new MineflayerBucketFiller(holderOf(bot))
    bot.setBlock({ x: 4, y: 63, z: 5 }, 'water')
    bot.setLiquidLevel({ x: 4, y: 63, z: 5 }, 3)
    bot.setBlock({ x: 5, y: 63, z: 5 }, 'lava')
    bot.setLiquidLevel({ x: 5, y: 63, z: 5 }, 8)

    expect(filler.liquidAt(source)).toEqual({ liquid: 'water', source: true })
    expect(filler.liquidAt({ x: 4, y: 63, z: 5 })).toEqual({ liquid: 'water', source: false })
    expect(filler.liquidAt({ x: 5, y: 63, z: 5 })).toEqual({ liquid: 'lava', source: false })
  })

  it('reads a numeric level as well as a numeric string', () => {
    const bot = withPool('lava')
    const block = bot.blockAt(toVec3(source))
    bot.blockAt = () => (block === null ? null : { ...block, getProperties: () => ({ level: 0 }) })

    expect(new MineflayerBucketFiller(holderOf(bot)).liquidAt(source)).toEqual({
      liquid: 'lava',
      source: true,
    })
  })

  it('does not count a cell as a source when the level is missing', () => {
    const bot = withPool()
    const block = bot.blockAt(toVec3(source))
    bot.blockAt = () => (block === null ? null : { ...block, getProperties: () => ({}) })

    expect(new MineflayerBucketFiller(holderOf(bot)).liquidAt(source)).toEqual({
      liquid: 'water',
      source: false,
    })
  })

  it.each([
    ['air', 'air'],
    ['stone', 'stone'],
  ])('finds no liquid in %s', (_label, name) => {
    const bot = withPool()
    bot.setBlock(source, name)

    expect(new MineflayerBucketFiller(holderOf(bot)).liquidAt(source)).toBeUndefined()
  })

  it('finds nothing in an unloaded cell or without a bot', () => {
    expect(
      new MineflayerBucketFiller(holderOf(withPool())).liquidAt({ x: 90, y: 63, z: 90 }),
    ).toBeUndefined()
    expect(new MineflayerBucketFiller(holderOf(undefined)).liquidAt(source)).toBeUndefined()
  })
})

describe('MineflayerBucketFiller.fill', () => {
  it('holds an empty bucket, looks at the source, uses it, and sees the filled bucket arrive', async () => {
    const bot = withPool()

    const result = await new MineflayerBucketFiller(holderOf(bot)).fill(source, signal())

    expect(result).toEqual({ ok: true, value: { item: 'water_bucket' } })
    expect(bot.activated).toEqual(['bucket'])
    expect(bot.lookedAt.at(-1)).toEqual({ x: 3.5, y: 63.5, z: 5.5 })
    expect(bot.count('water_bucket')).toBe(1)
    expect(bot.count('bucket')).toBe(1)
  })

  it('fills with lava from a lava source', async () => {
    const bot = withPool('lava')

    const result = await new MineflayerBucketFiller(holderOf(bot)).fill(source, signal())

    expect(result).toEqual({ ok: true, value: { item: 'lava_bucket' } })
    expect(bot.count('lava_bucket')).toBe(1)
    expect(bot.blockAt(toVec3(source))?.name).toBe('air')
  })

  it.each([
    ['not_connected', () => new MineflayerBucketFiller(holderOf(undefined))],
    [
      'no_bucket',
      () => {
        const bot = withPool()
        bot.removeItems('bucket', 2)
        return new MineflayerBucketFiller(holderOf(bot))
      },
    ],
    [
      'not_a_source',
      () => {
        const bot = withPool()
        bot.setBlock(source, 'stone')
        return new MineflayerBucketFiller(holderOf(bot))
      },
    ],
    [
      'not_a_source',
      () => {
        const bot = withPool()
        bot.setLiquidLevel(source, 4)
        return new MineflayerBucketFiller(holderOf(bot))
      },
    ],
    [
      'out_of_reach',
      () => {
        const bot = withPool()
        bot.entity = { position: { x: 30.5, y: 64, z: 3.5 } }
        return new MineflayerBucketFiller(holderOf(bot))
      },
    ],
  ])('reports %s', async (reason, make) => {
    const result = await make().fill(source, signal())

    expect(result).toMatchObject({ ok: false, error: { reason } })
  })

  it('explains that flowing liquid gives nothing', async () => {
    const bot = withPool()
    bot.setLiquidLevel(source, 2)

    const result = await new MineflayerBucketFiller(holderOf(bot)).fill(source, signal())

    expect(result).toMatchObject({ ok: false, error: { reason: 'not_a_source' } })
    if (!result.ok) expect(result.error.message).toContain('flowing')
    expect(bot.activated).toEqual([])
  })

  it('wraps a thrown call as failed', async () => {
    const bot = withPool()
    bot.equip = () => Promise.reject(new Error('cannot equip'))

    const result = await new MineflayerBucketFiller(holderOf(bot)).fill(source, signal())

    expect(result).toEqual({ ok: false, error: { reason: 'failed', message: 'cannot equip' } })
  })

  it('reports failed when the bucket does not fill', async () => {
    const bot = withPool()
    bot.activateItem = () => undefined

    const result = await new MineflayerBucketFiller(holderOf(bot)).fill(source, signal())

    expect(result).toMatchObject({ ok: false, error: { reason: 'failed' } })
  })

  it('stops waiting when aborted', async () => {
    const bot = withPool()
    bot.activateItem = () => undefined
    const controller = new AbortController()
    controller.abort()

    const result = await new MineflayerBucketFiller(holderOf(bot)).fill(source, controller.signal)

    expect(result).toEqual({ ok: false, error: { reason: 'failed', message: 'Cancelled.' } })
    expect(bot.waitedTicks).toBe(0)
  })
})
