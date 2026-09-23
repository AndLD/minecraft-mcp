import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerTiller } from '../../../src/bot/mineflayer-tiller.js'
import { toVec3 } from '../../../src/bot/vec3.js'
import { FakeBot } from '../../fakes/fake-bot.js'

const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})

const at = { x: 3, y: 64, z: 5 }

describe('MineflayerTiller', () => {
  it('equips a hoe and right-clicks the block, turning it into farmland', async () => {
    const bot = new FakeBot()
    bot.setBlock(at, 'dirt')
    bot.addItems('wooden_hoe', 1)
    const tiller = new MineflayerTiller(holderOf(bot))
    const signal = new AbortController().signal

    const result = await tiller.till(at, signal)

    expect(result).toEqual({ ok: true, value: undefined })
    expect(bot.activateBlockCalls).toEqual([at])
    expect(bot.equipped).toEqual([{ itemType: 140, slot: 'hand' }])
    expect(bot.blockAt(toVec3(at))?.name).toBe('farmland')
  })

  it('reports no_hoe when the bot carries none', async () => {
    const bot = new FakeBot()
    bot.setBlock(at, 'dirt')
    const tiller = new MineflayerTiller(holderOf(bot))

    const result = await tiller.till(at, new AbortController().signal)

    expect(result).toEqual({
      ok: false,
      error: { reason: 'no_hoe', message: 'The bot has no hoe to till with.' },
    })
    expect(bot.activateBlockCalls).toEqual([])
  })

  it('reports not_connected when there is no bot', async () => {
    const tiller = new MineflayerTiller(holderOf(undefined))

    const result = await tiller.till(at, new AbortController().signal)

    expect(result).toEqual({
      ok: false,
      error: { reason: 'not_connected', message: 'Not connected to a Minecraft world.' },
    })
  })

  it('reports out_of_reach when the block is not loaded', async () => {
    const bot = new FakeBot()
    bot.addItems('wooden_hoe', 1)
    const tiller = new MineflayerTiller(holderOf(bot))

    const result = await tiller.till(at, new AbortController().signal)

    expect(result).toMatchObject({ ok: false, error: { reason: 'out_of_reach' } })
  })

  it('fails cleanly when activating the block throws', async () => {
    const bot = new FakeBot()
    bot.setBlock(at, 'dirt')
    bot.addItems('wooden_hoe', 1)
    bot.activateBlock = () => Promise.reject(new Error('too far away'))
    const tiller = new MineflayerTiller(holderOf(bot))

    const result = await tiller.till(at, new AbortController().signal)

    expect(result).toEqual({ ok: false, error: { reason: 'failed', message: 'too far away' } })
  })
})
