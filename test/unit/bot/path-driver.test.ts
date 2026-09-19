import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerPathDriver, type GoalFactory } from '../../../src/bot/path-driver.js'
import { FakeBot } from '../../fakes/fake-bot.js'

const goals: GoalFactory = {
  near: (x, y, z, range) => ({ kind: 'near', x, y, z, range }),
  followEntity: (entity, range) => ({ kind: 'follow', id: entity.id, range }),
}

const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})

describe('MineflayerPathDriver', () => {
  describe('goNear', () => {
    it('asks the pathfinder to go near the target and reports arrival', async () => {
      const bot = new FakeBot()
      const driver = new MineflayerPathDriver(holderOf(bot), goals)

      const handle = driver.goNear({ x: 1, y: 2, z: 3 }, 2)
      bot.pathfinder.arrive()

      expect(bot.pathfinder.gotoGoals).toEqual([{ kind: 'near', x: 1, y: 2, z: 3, range: 2 }])
      expect(await handle.outcome).toEqual({ kind: 'reached' })
    })

    it.each(['NoPath', 'Timeout'])('maps a %s error to no_path', async (name) => {
      const bot = new FakeBot()
      const handle = new MineflayerPathDriver(holderOf(bot), goals).goNear({ x: 0, y: 0, z: 0 }, 1)

      bot.pathfinder.failWith(name)

      expect(await handle.outcome).toEqual({ kind: 'no_path' })
    })

    it('maps other pathfinder errors to a failure with the message', async () => {
      const bot = new FakeBot()
      const handle = new MineflayerPathDriver(holderOf(bot), goals).goNear({ x: 0, y: 0, z: 0 }, 1)

      bot.pathfinder.failWith('GoalChanged', 'The goal was changed')

      expect(await handle.outcome).toEqual({ kind: 'failed', message: 'The goal was changed' })
    })

    it('describes a non-Error rejection', async () => {
      const bot = new FakeBot()
      bot.pathfinder.goto = () => Promise.reject(new Error('plain'))
      const handle = new MineflayerPathDriver(holderOf(bot), goals).goNear({ x: 0, y: 0, z: 0 }, 1)

      expect(await handle.outcome).toEqual({ kind: 'failed', message: 'plain' })
    })

    it('stops the pathfinder and the controls when cancelled', async () => {
      const bot = new FakeBot()
      const handle = new MineflayerPathDriver(holderOf(bot), goals).goNear({ x: 0, y: 0, z: 0 }, 1)

      handle.cancel()

      expect(bot.pathfinder.stopCalls).toBe(1)
      expect(bot.clearControlStatesCalls).toBe(1)
      expect(await handle.outcome).toEqual({ kind: 'failed', message: 'Cancelled.' })
    })

    it('fails at once without a bot', async () => {
      const handle = new MineflayerPathDriver(holderOf(undefined), goals).goNear(
        { x: 0, y: 0, z: 0 },
        1,
      )

      expect(await handle.outcome).toEqual({
        kind: 'failed',
        message: 'Not connected to a Minecraft world.',
      })
      expect(() => {
        handle.cancel()
      }).not.toThrow()
    })
  })

  describe('follow', () => {
    function botWithPlayer() {
      const bot = new FakeBot()
      bot.players['Andrey_Knight'] = {
        username: 'Andrey_Knight',
        entity: {
          id: 7,
          type: 'player',
          username: 'Andrey_Knight',
          position: { x: 5, y: 64, z: 5 },
        },
      }
      return bot
    }

    it('follows the player entity with a dynamic goal', () => {
      const bot = botWithPlayer()

      new MineflayerPathDriver(holderOf(bot), goals).follow('andrey_knight', 3)

      expect(bot.pathfinder.followGoals).toEqual([
        { goal: { kind: 'follow', id: 7, range: 3 }, dynamic: true },
      ])
    })

    it('stops following when cancelled and settles the outcome', async () => {
      const bot = botWithPlayer()
      const handle = new MineflayerPathDriver(holderOf(bot), goals).follow('Andrey_Knight', 3)

      handle.cancel()

      expect(bot.pathfinder.stopCalls).toBe(1)
      expect(bot.clearControlStatesCalls).toBe(1)
      expect(await handle.outcome).toEqual({ kind: 'failed', message: 'Cancelled.' })
    })

    it('fails when the player is not in view', async () => {
      const bot = new FakeBot()
      bot.players['Andrey_Knight'] = { username: 'Andrey_Knight' }

      const handle = new MineflayerPathDriver(holderOf(bot), goals).follow('Andrey_Knight', 3)

      expect(await handle.outcome).toEqual({
        kind: 'failed',
        message: 'Andrey_Knight is not in view, so it cannot be followed.',
      })
    })

    it('fails at once without a bot', async () => {
      const handle = new MineflayerPathDriver(holderOf(undefined), goals).follow('A', 3)

      expect((await handle.outcome).kind).toBe('failed')
    })
  })

  it('cancelling after the bot is gone is harmless', () => {
    const bot = new FakeBot()
    let current: BotLike | undefined = bot
    const holder: BotHolder = { current: () => current, onChange: () => () => undefined }
    const handle = new MineflayerPathDriver(holder, goals).goNear({ x: 0, y: 0, z: 0 }, 1)

    current = undefined

    expect(() => {
      handle.cancel()
    }).not.toThrow()
  })
})

describe('MineflayerPathDriver.approachEntity', () => {
  it('chases the entity with a dynamic goal, and stops when cancelled', async () => {
    const bot = new FakeBot()
    bot.entities['7'] = { id: 7, type: 'hostile', name: 'zombie', position: { x: 4, y: 64, z: 0 } }
    const handle = new MineflayerPathDriver(holderOf(bot), goals).approachEntity(7, 1.8)

    expect(bot.pathfinder.followGoals).toEqual([
      { goal: { kind: 'follow', id: 7, range: 1.8 }, dynamic: true },
    ])
    handle.cancel()

    expect(bot.pathfinder.stopCalls).toBe(1)
    expect(await handle.outcome).toEqual({ kind: 'failed', message: 'Cancelled.' })
  })

  it('fails when the entity is not in view, or without a bot', async () => {
    const bot = new FakeBot()

    expect(
      await new MineflayerPathDriver(holderOf(bot), goals).approachEntity(99, 2).outcome,
    ).toEqual({
      kind: 'failed',
      message: 'Entity 99 is not in view.',
    })
    expect(
      (await new MineflayerPathDriver(holderOf(undefined), goals).approachEntity(1, 2).outcome)
        .kind,
    ).toBe('failed')
  })
})
