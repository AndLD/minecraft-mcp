import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { toVec3 } from '../../../src/bot/vec3.js'
import { MineflayerSignAccess } from '../../../src/bot/mineflayer-sign-access.js'
import { FakeBot } from '../../fakes/fake-bot.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { AutoScheduler } from '../../fakes/gathering-fakes.js'

const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})
const at = { x: 4, y: 64, z: 4 }
const signal = (): AbortSignal => new AbortController().signal

function setup() {
  const bot = new FakeBot()
  const access = new MineflayerSignAccess(holderOf(bot), new AutoScheduler(new FakeClock(0)))
  return { bot, access }
}

describe('MineflayerSignAccess.stateAt', () => {
  it('reads both sides as four lines, whether it is waxed, and which way it faces', () => {
    const { bot, access } = setup()
    bot.setSign(at, { front: 'Iron\nchest', back: 'Back', waxed: true, facing: 'east' })

    expect(access.stateAt(at)).toEqual({
      name: 'oak_wall_sign',
      front: ['Iron', 'chest', '', ''],
      back: ['Back', '', '', ''],
      waxed: true,
      facing: 'east',
    })
  })

  it('turns the rotation of a standing sign into the nearest compass direction', () => {
    const { bot, access } = setup()

    bot.setSign(at, { name: 'oak_sign', rotation: 0 })
    expect(access.stateAt(at)?.facing).toBe('south')
    bot.setSign(at, { name: 'oak_sign', rotation: 4 })
    expect(access.stateAt(at)?.facing).toBe('west')
    bot.setSign(at, { name: 'oak_sign', rotation: 9 })
    expect(access.stateAt(at)?.facing).toBe('north')
    bot.setSign(at, { name: 'oak_sign', rotation: 15 })
    expect(access.stateAt(at)?.facing).toBe('south')
  })

  it('is undefined for anything that is not a sign, a hanging sign, or an unloaded place', () => {
    const { bot, access } = setup()
    bot.setBlock(at, 'stone')
    bot.setBlock({ x: 5, y: 64, z: 4 }, 'oak_hanging_sign')

    expect(access.stateAt(at)).toBeUndefined()
    expect(access.stateAt({ x: 5, y: 64, z: 4 })).toBeUndefined()
    expect(access.stateAt({ x: 99, y: 64, z: 99 })).toBeUndefined()
    expect(
      new MineflayerSignAccess(holderOf(undefined), new AutoScheduler(new FakeClock(0))).stateAt(
        at,
      ),
    ).toBeUndefined()
  })
})

describe('MineflayerSignAccess.write', () => {
  it('sends the lines for a sign the server has just opened for the bot, without a click', async () => {
    const { bot, access } = setup()
    // A sign the bot placed itself: the server has opened its editor for the bot.
    bot.setBlock({ x: 4, y: 63, z: 4 }, 'stone')
    bot.addItems('oak_sign', 1)
    bot.heldItem = { name: 'oak_sign', count: 1 }
    const ground = bot.blockAt(toVec3({ x: 4, y: 63, z: 4 }))
    if (ground === null) throw new Error('no ground')
    await bot.placeBlock(ground, { x: 0, y: 1, z: 0 })
    const placed = { x: 4, y: 64, z: 4 }

    const result = await access.write(placed, 'front', ['Iron', '', '', ''], false, signal())

    expect(result.ok).toBe(true)
    expect(bot.activateBlockCalls).toEqual([])
    expect(bot.signUpdates).toEqual([{ position: placed, text: 'Iron\n\n\n', back: false }])
    expect(access.stateAt(placed)?.front[0]).toBe('Iron')
  })

  it('right-clicks an existing sign, waits for the editor, then sends the text (back side too)', async () => {
    const { bot, access } = setup()
    bot.setSign(at, { front: 'Old' })

    const result = await access.write(at, 'back', ['New'], true, signal())

    expect(result.ok).toBe(true)
    expect(bot.activateBlockCalls).toEqual([at])
    expect(bot.signUpdates).toEqual([{ position: at, text: 'New', back: true }])
    expect(access.stateAt(at)?.back[0]).toBe('New')
    expect(access.stateAt(at)?.front[0]).toBe('Old')
  })

  it('reports a sign whose editor never opened (waxed)', async () => {
    const { bot, access } = setup()
    bot.setSign(at, { front: 'Old', waxed: true })

    const result = await access.write(at, 'front', ['New'], true, signal())

    expect(result).toMatchObject({ ok: false, error: { reason: 'not_editable' } })
    expect(bot.signUpdates).toEqual([])
  })

  it('reports no sign there, and no connection', async () => {
    const { access } = setup()
    expect(await access.write(at, 'front', ['x'], false, signal())).toMatchObject({
      ok: false,
      error: { reason: 'out_of_reach' },
    })
    const detached = new MineflayerSignAccess(
      holderOf(undefined),
      new AutoScheduler(new FakeClock(0)),
    )
    expect(await detached.write(at, 'front', ['x'], false, signal())).toMatchObject({
      ok: false,
      error: { reason: 'not_connected' },
    })
  })

  it('reports an error from sending the text, and still stops listening', async () => {
    const { bot, access } = setup()
    bot.setSign(at)
    bot.updateSign = () => {
      throw new Error('socket closed')
    }

    const result = await access.write(at, 'front', ['x'], false, signal())

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'failed', message: 'socket closed' },
    })
    expect(bot.listenerCount('signOpen')).toBe(0)
  })

  it('stops listening for the editor when it is done', async () => {
    const { bot, access } = setup()
    bot.setSign(at)

    await access.write(at, 'front', ['x'], true, signal())

    expect(bot.listenerCount('signOpen')).toBe(0)
  })
})
