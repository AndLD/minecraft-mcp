import { describe, expect, it } from '@jest/globals'
import type { BotHolder } from '../../../src/bot/bot-like.types.js'
import { MineflayerNavigator } from '../../../src/bot/mineflayer-navigator.js'
import type { PathDriver, PathHandle, PathOutcome } from '../../../src/bot/path-driver.js'
import type { Position } from '../../../src/core/position.types.js'
import { FakeBot } from '../../fakes/fake-bot.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { FakeEntityScanner } from '../../fakes/fake-ports.js'
import { FakeScheduler } from '../../fakes/fake-scheduler.js'

class FakeDriver implements PathDriver {
  readonly near: { target: Position; range: number }[] = []
  readonly follows: { player: string; distance: number }[] = []
  private settle: (outcome: PathOutcome) => void = () => undefined
  cancelled = 0

  goNear(target: Position, range: number): PathHandle {
    this.near.push({ target, range })
    return this.handle()
  }

  follow(player: string, distance: number): PathHandle {
    this.follows.push({ player, distance })
    return this.handle()
  }

  approachEntity(): PathHandle {
    return this.handle()
  }

  finish(outcome: PathOutcome): void {
    this.settle(outcome)
  }

  private handle(): PathHandle {
    const outcome = new Promise<PathOutcome>((resolve) => {
      this.settle = resolve
    })
    return {
      outcome,
      cancel: () => {
        this.cancelled += 1
      },
    }
  }
}

function setup() {
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const bot = new FakeBot()
  bot.entity = { position: { x: 0, y: 64, z: 0 } }
  const holder: BotHolder = { current: () => bot, onChange: () => () => undefined }
  const driver = new FakeDriver()
  const entities = new FakeEntityScanner()
  const navigator = new MineflayerNavigator({ holder, driver, entities, clock, scheduler })
  return { bot, driver, entities, navigator, scheduler }
}

const signal = () => new AbortController().signal

describe('MineflayerNavigator', () => {
  describe('goToPosition', () => {
    it('drives to the target and reports where the bot ended up', async () => {
      const { navigator, driver, bot } = setup()

      const running = navigator.goToPosition({ x: 10, y: 64, z: 0 }, 2, { signal: signal() })
      bot.entity = { position: { x: 9, y: 64, z: 0 } }
      driver.finish({ kind: 'reached' })

      expect(driver.near).toEqual([{ target: { x: 10, y: 64, z: 0 }, range: 2 }])
      expect(await running).toEqual({ ok: true, value: { x: 9, y: 64, z: 0 } })
    })

    it.each([
      [10, 45],
      [100, 180],
    ])('allows 30 s plus 1.5 s per block: a %s block trip gets %s s', async (blocks, seconds) => {
      const { navigator, scheduler, bot } = setup()
      const running = navigator.goToPosition({ x: blocks, y: 64, z: 0 }, 2, { signal: signal() })

      for (let second = 1; second <= seconds; second += 1) {
        bot.entity = { position: { x: second, y: 64, z: 0 } } // moving, so it is never "stuck"
        scheduler.advance(1000)
      }

      expect(await running).toEqual({
        ok: false,
        error: { reason: 'timeout', message: `Did not arrive within ${String(seconds)} s.` },
      })
    })
  })

  describe('goToPlayer', () => {
    it('goes to where the player is', async () => {
      const { navigator, driver, entities } = setup()
      entities.players.set('andrey_knight', {
        name: 'Andrey_Knight',
        online: true,
        position: { x: 20, y: 64, z: 0 },
        distance: 20,
      })

      const running = navigator.goToPlayer('Andrey_Knight', 3, { signal: signal() })
      driver.finish({ kind: 'reached' })

      expect(driver.near).toEqual([{ target: { x: 20, y: 64, z: 0 }, range: 3 }])
      expect((await running).ok).toBe(true)
    })

    it('fails when the player is not online', async () => {
      const { navigator } = setup()

      const result = await navigator.goToPlayer('Nobody', 3, { signal: signal() })

      expect(result).toEqual({
        ok: false,
        error: { reason: 'target_not_found', message: 'Nobody is not online.' },
      })
    })

    it('fails when the player is online but out of view', async () => {
      const { navigator, entities } = setup()
      entities.players.set('far', {
        name: 'Far',
        online: true,
        position: undefined,
        distance: undefined,
      })

      const result = await navigator.goToPlayer('Far', 3, { signal: signal() })

      expect(!result.ok && result.error.reason).toBe('target_not_found')
      expect(!result.ok && result.error.message).toContain('out of view')
    })
  })

  describe('follow', () => {
    it('follows until cancelled, which counts as success', async () => {
      const { navigator, driver, entities } = setup()
      entities.players.set('a', {
        name: 'A',
        online: true,
        position: { x: 1, y: 64, z: 1 },
        distance: 1,
      })
      const controller = new AbortController()

      const running = navigator.follow('A', 3, { signal: controller.signal })
      controller.abort()

      expect(driver.follows).toEqual([{ player: 'A', distance: 3 }])
      expect(await running).toEqual({ ok: true, value: undefined })
      expect(driver.cancelled).toBe(1)
    })

    it('fails when the player is lost', async () => {
      const { navigator, scheduler, entities } = setup()
      entities.players.set('a', {
        name: 'A',
        online: true,
        position: undefined,
        distance: undefined,
      })

      const running = navigator.follow('A', 3, { signal: signal() })
      scheduler.advance(11_000)

      const result = await running
      expect(!result.ok && result.error.reason).toBe('target_not_found')
    })

    it('fails when the driver cannot follow', async () => {
      const { navigator, driver, entities } = setup()
      entities.players.set('a', {
        name: 'A',
        online: true,
        position: { x: 1, y: 64, z: 1 },
        distance: 1,
      })

      const running = navigator.follow('A', 3, { signal: signal() })
      driver.finish({ kind: 'failed', message: 'A is not in view' })

      expect(await running).toEqual({
        ok: false,
        error: { reason: 'unreachable', message: 'A is not in view' },
      })
    })
  })
})
