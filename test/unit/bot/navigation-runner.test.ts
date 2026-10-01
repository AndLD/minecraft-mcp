import { describe, expect, it } from '@jest/globals'
import { NavigationRunner } from '../../../src/bot/navigation-runner.js'
import type { PathHandle, PathOutcome } from '../../../src/bot/path-driver.js'
import type { NavigationProgress } from '../../../src/core/navigator.port.js'
import type { Position } from '../../../src/core/position.types.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { FakeScheduler } from '../../fakes/fake-scheduler.js'

/** A movement the test finishes by hand; records whether it was cancelled. */
function fakeHandle() {
  let settle: (outcome: PathOutcome) => void = () => undefined
  const outcome = new Promise<PathOutcome>((resolve) => {
    settle = resolve
  })
  const state = { cancelled: 0 }
  const handle: PathHandle = {
    outcome,
    cancel: () => {
      state.cancelled += 1
    },
  }
  return {
    handle,
    state,
    settle: (o: PathOutcome) => {
      settle(o)
    },
  }
}

function setup(
  options: {
    position?: Position | undefined
    stuckAfterMs?: number
    targetLostAfterMs?: number
  } = {},
) {
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const bot = { position: 'position' in options ? options.position : { x: 0, y: 64, z: 0 } }
  const runner = new NavigationRunner({
    clock,
    scheduler,
    currentPosition: () => bot.position,
    pollMs: 1000,
    ...(options.stuckAfterMs === undefined ? {} : { stuckAfterMs: options.stuckAfterMs }),
    ...(options.targetLostAfterMs === undefined
      ? {}
      : { targetLostAfterMs: options.targetLostAfterMs }),
  })
  return { clock, scheduler, bot, runner }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const goal = { x: 100, y: 64, z: 0 }

describe('NavigationRunner', () => {
  it('reports arrival with the final position', async () => {
    const { runner, bot } = setup()
    const movement = fakeHandle()
    const running = runner.run({
      start: () => movement.handle,
      signal: new AbortController().signal,
      goal,
    })

    bot.position = { x: 99, y: 64, z: 0 }
    movement.settle({ kind: 'reached' })

    expect(await running).toEqual({ ok: true, value: { x: 99, y: 64, z: 0 } })
    // The trip ended by itself: stopping an idle pathfinder would break the next trip.
    expect(movement.state.cancelled).toBe(0)
  })

  it('reports an unreachable target when there is no path', async () => {
    const { runner } = setup()
    const movement = fakeHandle()
    const running = runner.run({
      start: () => movement.handle,
      signal: new AbortController().signal,
      goal,
    })

    movement.settle({ kind: 'no_path' })

    const result = await running
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.reason).toBe('unreachable')
    expect(movement.state.cancelled).toBe(0)
  })

  it('passes the pathfinder failure message through', async () => {
    const { runner } = setup()
    const movement = fakeHandle()
    const running = runner.run({
      start: () => movement.handle,
      signal: new AbortController().signal,
      goal,
    })

    movement.settle({ kind: 'failed', message: 'The chunk is not loaded.' })

    expect(await running).toEqual({
      ok: false,
      error: { reason: 'unreachable', message: 'The chunk is not loaded.' },
    })
  })

  it('does not start when already aborted', async () => {
    const { runner } = setup()
    const controller = new AbortController()
    controller.abort()
    let started = false

    const result = await runner.run({
      start: () => {
        started = true
        return fakeHandle().handle
      },
      signal: controller.signal,
      goal,
    })

    expect(started).toBe(false)
    expect(!result.ok && result.error.reason).toBe('aborted')
  })

  it('does not start when the bot is not in a world', async () => {
    const { runner } = setup({ position: undefined })

    const result = await runner.run({
      start: () => fakeHandle().handle,
      signal: new AbortController().signal,
      goal,
    })

    expect(!result.ok && result.error.reason).toBe('not_connected')
  })

  it('stops the movement immediately when aborted', async () => {
    const { runner, scheduler } = setup()
    const movement = fakeHandle()
    const controller = new AbortController()
    const running = runner.run({
      start: () => movement.handle,
      signal: controller.signal,
      goal,
      timeoutMs: 60_000,
    })

    controller.abort()
    const result = await running

    expect(!result.ok && result.error.reason).toBe('aborted')
    expect(movement.state.cancelled).toBe(1)
    expect(scheduler.pendingCount).toBe(0)
  })

  it('gives up after the overall timeout', async () => {
    const { runner, scheduler, bot } = setup()
    const movement = fakeHandle()
    const running = runner.run({
      start: () => movement.handle,
      signal: new AbortController().signal,
      goal,
      timeoutMs: 20_000,
    })

    for (let second = 1; second <= 20; second += 1) {
      bot.position = { x: second * 2, y: 64, z: 0 } // keeps moving, so it is not "stuck"
      scheduler.advance(1000)
    }
    const result = await running

    expect(result).toEqual({
      ok: false,
      error: { reason: 'timeout', message: 'Did not arrive within 20 s.' },
    })
    expect(movement.state.cancelled).toBe(1)
  })

  it('reports being stuck when the bot does not move', async () => {
    const { runner, scheduler } = setup({ stuckAfterMs: 5000 })
    const movement = fakeHandle()
    const running = runner.run({
      start: () => movement.handle,
      signal: new AbortController().signal,
      goal,
    })

    scheduler.advance(6000)
    const result = await running

    expect(!result.ok && result.error.reason).toBe('stuck')
    expect(movement.state.cancelled).toBe(1)
  })

  it('is not stuck while the bot keeps making progress', async () => {
    const { runner, scheduler, bot } = setup({ stuckAfterMs: 5000 })
    const movement = fakeHandle()
    const running = runner.run({
      start: () => movement.handle,
      signal: new AbortController().signal,
      goal,
    })

    for (let second = 1; second <= 12; second += 1) {
      bot.position = { x: second, y: 64, z: 0 }
      scheduler.advance(1000)
    }
    movement.settle({ kind: 'reached' })

    expect((await running).ok).toBe(true)
  })

  it('does not treat standing still as stuck when there is no fixed goal (following)', async () => {
    const { runner, scheduler } = setup({ stuckAfterMs: 5000 })
    const movement = fakeHandle()
    const controller = new AbortController()
    const running = runner.run({
      start: () => movement.handle,
      signal: controller.signal,
      targetInView: () => true,
    })

    scheduler.advance(60_000)
    controller.abort()

    expect((await running).ok).toBe(false)
    expect(movement.state.cancelled).toBe(1)
  })

  it('reports progress with the distance remaining', async () => {
    const { runner, scheduler, bot } = setup()
    const movement = fakeHandle()
    const seen: NavigationProgress[] = []
    const running = runner.run({
      start: () => movement.handle,
      signal: new AbortController().signal,
      goal,
      onProgress: (p) => seen.push(p),
    })

    bot.position = { x: 60, y: 64, z: 0 }
    scheduler.advance(1000)
    movement.settle({ kind: 'reached' })
    await running

    expect(seen).toEqual([{ position: { x: 60, y: 64, z: 0 }, distanceRemaining: 40 }])
  })

  it('reports progress without a distance when there is no fixed goal', async () => {
    const { runner, scheduler } = setup()
    const movement = fakeHandle()
    const seen: NavigationProgress[] = []
    const controller = new AbortController()
    const running = runner.run({
      start: () => movement.handle,
      signal: controller.signal,
      targetInView: () => true,
      onProgress: (p) => seen.push(p),
    })

    scheduler.advance(1000)
    controller.abort()
    await running

    expect(seen[0]?.distanceRemaining).toBeUndefined()
  })

  it('fails when the bot leaves the world while moving', async () => {
    const { runner, scheduler, bot } = setup()
    const movement = fakeHandle()
    const running = runner.run({
      start: () => movement.handle,
      signal: new AbortController().signal,
      goal,
    })

    bot.position = undefined
    scheduler.advance(1000)

    expect(!(await running).ok).toBe(true)
  })

  it('reports a lost connection on arrival', async () => {
    const { runner, bot } = setup()
    const movement = fakeHandle()
    const running = runner.run({
      start: () => movement.handle,
      signal: new AbortController().signal,
      goal,
    })

    bot.position = undefined
    movement.settle({ kind: 'reached' })

    const result = await running
    expect(!result.ok && result.error.reason).toBe('not_connected')
  })

  describe('following', () => {
    it('gives up when the target stays out of view for too long', async () => {
      const { runner, scheduler } = setup({ targetLostAfterMs: 5000 })
      const movement = fakeHandle()
      const running = runner.run({
        start: () => movement.handle,
        signal: new AbortController().signal,
        targetInView: () => false,
      })

      scheduler.advance(6000)
      const result = await running

      expect(!result.ok && result.error.reason).toBe('target_not_found')
    })

    it('forgives a target that comes back into view in time', async () => {
      const { runner, scheduler } = setup({ targetLostAfterMs: 5000 })
      const movement = fakeHandle()
      let inView = false
      const controller = new AbortController()
      const running = runner.run({
        start: () => movement.handle,
        signal: controller.signal,
        targetInView: () => inView,
      })

      scheduler.advance(3000)
      inView = true
      scheduler.advance(3000)
      inView = false
      scheduler.advance(3000)
      controller.abort()
      const result = await running

      expect(!result.ok && result.error.reason).toBe('aborted')
    })
  })

  it('ignores an outcome that arrives after it already finished', async () => {
    const { runner } = setup()
    const movement = fakeHandle()
    const controller = new AbortController()
    const running = runner.run({ start: () => movement.handle, signal: controller.signal, goal })

    controller.abort()
    await running
    movement.settle({ kind: 'reached' })
    await flush()

    expect(movement.state.cancelled).toBe(1)
  })
})
