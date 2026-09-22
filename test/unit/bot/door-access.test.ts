import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerDoorAccess } from '../../../src/bot/mineflayer-door-access.js'
import { FakeBot } from '../../fakes/fake-bot.js'

const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})

const at = { x: 3, y: 64, z: 5 }

describe('MineflayerDoorAccess', () => {
  it('reads the name and open state of a door-like block', () => {
    const bot = new FakeBot()
    bot.setBlock(at, 'oak_door')
    bot.setDoorOpen(at, true)
    const access = new MineflayerDoorAccess(holderOf(bot))

    expect(access.stateAt(at)).toEqual({ name: 'oak_door', open: true })
  })

  it('defaults to closed when nobody has opened it', () => {
    const bot = new FakeBot()
    bot.setBlock(at, 'oak_door')
    const access = new MineflayerDoorAccess(holderOf(bot))

    expect(access.stateAt(at)).toEqual({ name: 'oak_door', open: false })
  })

  it('is undefined for a block that is not loaded', () => {
    const bot = new FakeBot()
    const access = new MineflayerDoorAccess(holderOf(bot))

    expect(access.stateAt(at)).toBeUndefined()
  })

  it('right-clicks the block to toggle it, and confirms the new state', async () => {
    const bot = new FakeBot()
    bot.setBlock(at, 'oak_door')
    const access = new MineflayerDoorAccess(holderOf(bot))
    const signal = new AbortController().signal

    const result = await access.toggle(at, signal)

    expect(result).toEqual({ ok: true, value: undefined })
    expect(bot.activateBlockCalls).toEqual([at])
    expect(access.stateAt(at)).toEqual({ name: 'oak_door', open: true })
  })

  it('reports not_connected when there is no bot', async () => {
    const access = new MineflayerDoorAccess(holderOf(undefined))

    const result = await access.toggle(at, new AbortController().signal)

    expect(result).toEqual({
      ok: false,
      error: { reason: 'not_connected', message: 'Not connected to a Minecraft world.' },
    })
  })

  it('reports out_of_reach when the block is not loaded', async () => {
    const bot = new FakeBot()
    const access = new MineflayerDoorAccess(holderOf(bot))

    const result = await access.toggle(at, new AbortController().signal)

    expect(result).toMatchObject({ ok: false, error: { reason: 'out_of_reach' } })
  })

  it('fails cleanly when activating the block throws', async () => {
    const bot = new FakeBot()
    bot.setBlock(at, 'oak_door')
    bot.activateBlock = () => Promise.reject(new Error('too far away'))
    const access = new MineflayerDoorAccess(holderOf(bot))

    const result = await access.toggle(at, new AbortController().signal)

    expect(result).toEqual({ ok: false, error: { reason: 'failed', message: 'too far away' } })
  })
})
