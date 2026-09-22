import { describe, expect, it } from '@jest/globals'
import type { DoorAccess, DoorFailure, DoorState } from '../../../../src/core/door.port.js'
import type {
  NavigationFailure,
  NavigationOptions,
  Navigator,
} from '../../../../src/core/navigator.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { err, ok, type Result } from '../../../../src/core/result.js'
import { DoorOpeningNavigator } from '../../../../src/skills/movement/door-opening-navigator.js'
import { FakeBlockScanner } from '../../../fakes/fake-ports.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })
const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`

class FakeDoorAccess implements DoorAccess {
  readonly toggled: Position[] = []
  private readonly states = new Map<string, DoorState>()
  /** A position whose toggle never actually flips the state (simulates a door that will not respond at all). */
  stuckAt: string | undefined
  /** A position that opens normally but refuses to close again. */
  wontCloseAt: string | undefined

  set(position: Position, name: string, open: boolean): void {
    this.states.set(key(position), { name, open })
  }

  stateAt(position: Position): DoorState | undefined {
    return this.states.get(key(position))
  }

  toggle(position: Position): Promise<Result<void, DoorFailure>> {
    this.toggled.push(position)
    const k = key(position)
    const current = this.states.get(k)
    if (k === this.stuckAt || current === undefined) return Promise.resolve(ok(undefined))
    if (k === this.wontCloseAt && current.open) return Promise.resolve(ok(undefined))
    this.states.set(k, { ...current, open: !current.open })
    return Promise.resolve(ok(undefined))
  }
}

/** A Navigator whose goToPosition/goToPlayer replay a queued sequence of results, one per call. */
class SequenceNavigator implements Navigator {
  readonly goToPositionCalls: { target: Position; within: number }[] = []
  readonly goToPlayerCalls: { player: string; within: number }[] = []
  readonly followCalls: { player: string; distance: number }[] = []
  private results: Result<Position, NavigationFailure>[] = []

  queue(...results: Result<Position, NavigationFailure>[]): void {
    this.results.push(...results)
  }

  goToPosition(
    target: Position,
    within: number,
    _options: NavigationOptions,
  ): Promise<Result<Position, NavigationFailure>> {
    this.goToPositionCalls.push({ target, within })
    return Promise.resolve(this.results.shift() ?? ok(target))
  }

  goToPlayer(
    player: string,
    within: number,
    _options: NavigationOptions,
  ): Promise<Result<Position, NavigationFailure>> {
    this.goToPlayerCalls.push({ player, within })
    return Promise.resolve(this.results.shift() ?? ok(at(0, 0, 0)))
  }

  follow(
    player: string,
    distance: number,
    _options: NavigationOptions,
  ): Promise<Result<void, NavigationFailure>> {
    this.followCalls.push({ player, distance })
    return Promise.resolve(ok(undefined))
  }
}

function setup() {
  const inner = new SequenceNavigator()
  const blocks = new FakeBlockScanner()
  blocks.names = ['oak_door', 'oak_fence_gate', 'oak_trapdoor', 'iron_door', 'iron_trapdoor', 'stone']
  const doors = new FakeDoorAccess()
  const logger = new FakeLogger()
  const navigator = new DoorOpeningNavigator({ inner, blocks, doors, logger })
  return { inner, blocks, doors, logger, navigator }
}

const options = (): NavigationOptions => ({ signal: new AbortController().signal })
const target = at(10, 64, 10)
const unreachable: NavigationFailure = { reason: 'unreachable', message: 'No path.' }
const stuckFailure: NavigationFailure = { reason: 'stuck', message: 'Not moving.' }

describe('DoorOpeningNavigator', () => {
  it('passes a successful trip straight through when nothing is in the way', async () => {
    const s = setup()
    s.inner.queue(ok(target))

    const result = await s.navigator.goToPosition(target, 2, options())

    expect(result).toEqual({ ok: true, value: target })
    expect(s.inner.goToPositionCalls).toHaveLength(1)
    expect(s.doors.toggled).toEqual([])
  })

  it('opens a closed door in the way, retries, and succeeds', async () => {
    const s = setup()
    const doorAt = at(5, 64, 5)
    s.doors.set(doorAt, 'oak_door', false)
    s.blocks.blocks = [{ name: 'oak_door', position: doorAt, distance: 3 }]
    s.inner.queue(err(unreachable), ok(target))

    const result = await s.navigator.goToPosition(target, 2, options())

    expect(result).toEqual({ ok: true, value: target })
    expect(s.inner.goToPositionCalls).toHaveLength(2)
    // Opened once, then closed again behind the bot once the trip succeeded.
    expect(s.doors.toggled).toEqual([doorAt, doorAt])
    expect(s.doors.stateAt(doorAt)).toEqual({ name: 'oak_door', open: false })
  })

  it('leaves the door open when closeDoors is false', async () => {
    const s = setup()
    const doorAt = at(5, 64, 5)
    s.doors.set(doorAt, 'oak_fence_gate', false)
    s.blocks.blocks = [{ name: 'oak_fence_gate', position: doorAt, distance: 3 }]
    s.inner.queue(err(unreachable), ok(target))

    const result = await s.navigator.goToPosition(target, 2, { ...options(), closeDoors: false })

    expect(result).toEqual({ ok: true, value: target })
    expect(s.doors.toggled).toEqual([doorAt]) // opened, never closed again
    expect(s.doors.stateAt(doorAt)?.open).toBe(true)
  })

  it('reports needs_switch for an iron door instead of trying it', async () => {
    const s = setup()
    const doorAt = at(5, 64, 5)
    s.doors.set(doorAt, 'iron_door', false)
    s.blocks.blocks = [{ name: 'iron_door', position: doorAt, distance: 3 }]
    s.inner.queue(err(unreachable))

    const result = await s.navigator.goToPosition(target, 2, options())

    expect(result).toEqual({
      ok: false,
      error: { reason: 'needs_switch', message: expect.stringContaining('iron_door') as unknown as string },
    })
    expect(s.doors.toggled).toEqual([]) // never tried to open it
    expect(s.inner.goToPositionCalls).toHaveLength(1) // no retry
  })

  it('reports door_stuck when a door will not open after two tries', async () => {
    const s = setup()
    const doorAt = at(5, 64, 5)
    s.doors.set(doorAt, 'oak_trapdoor', false)
    s.doors.stuckAt = key(doorAt)
    s.blocks.blocks = [{ name: 'oak_trapdoor', position: doorAt, distance: 3 }]
    s.inner.queue(err(unreachable))

    const result = await s.navigator.goToPosition(target, 2, options())

    expect(result).toEqual({
      ok: false,
      error: { reason: 'door_stuck', message: expect.stringContaining('oak_trapdoor') as unknown as string },
    })
    expect(s.doors.toggled).toEqual([doorAt, doorAt]) // two tries
    expect(s.inner.goToPositionCalls).toHaveLength(1) // never retried the trip itself
  })

  it('leaves an unrelated failure (no door nearby) unchanged', async () => {
    const s = setup()
    s.inner.queue(err(unreachable))

    const result = await s.navigator.goToPosition(target, 2, options())

    expect(result).toEqual({ ok: false, error: unreachable })
    expect(s.doors.toggled).toEqual([])
    expect(s.inner.goToPositionCalls).toHaveLength(1)
  })

  it('does not touch doors for a failure that is not unreachable or stuck', async () => {
    const s = setup()
    const doorAt = at(5, 64, 5)
    s.doors.set(doorAt, 'oak_door', false)
    s.blocks.blocks = [{ name: 'oak_door', position: doorAt, distance: 3 }]
    s.inner.queue(err({ reason: 'target_not_found', message: 'Gone.' }))

    const result = await s.navigator.goToPosition(target, 2, options())

    expect(result).toEqual({ ok: false, error: { reason: 'target_not_found', message: 'Gone.' } })
    expect(s.doors.toggled).toEqual([])
  })

  it('tries the next nearest door when the first one opened does not clear the way, up to the trip limit', async () => {
    const s = setup()
    const first = at(5, 64, 5)
    const second = at(6, 64, 5)
    s.doors.set(first, 'oak_door', false)
    s.doors.set(second, 'oak_door', false)
    s.blocks.blocks = [
      { name: 'oak_door', position: first, distance: 3 },
      { name: 'oak_door', position: second, distance: 4 },
    ]
    s.inner.queue(err(unreachable), err(unreachable), ok(target))

    const result = await s.navigator.goToPosition(target, 2, options())

    expect(result).toEqual({ ok: true, value: target })
    expect(s.inner.goToPositionCalls).toHaveLength(3)
    // Opened both, closed both again behind the bot.
    expect(s.doors.toggled).toEqual([first, second, first, second])
  })

  it('gives up after a stuck failure keeps recurring with an already-open door already tried', async () => {
    const s = setup()
    s.inner.queue(err(stuckFailure), err(stuckFailure), err(stuckFailure), err(stuckFailure))
    // No door blocks at all near the bot.

    const result = await s.navigator.goToPosition(target, 2, options())

    expect(result).toEqual({ ok: false, error: stuckFailure })
    expect(s.inner.goToPositionCalls).toHaveLength(1)
  })

  it('resolves a door for a player-target trip too', async () => {
    const s = setup()
    const doorAt = at(5, 64, 5)
    s.doors.set(doorAt, 'oak_door', false)
    s.blocks.blocks = [{ name: 'oak_door', position: doorAt, distance: 3 }]
    s.inner.queue(err(unreachable), ok(at(1, 1, 1)))

    const result = await s.navigator.goToPlayer('Andrey_Knight', 2, options())

    expect(result).toEqual({ ok: true, value: at(1, 1, 1) })
    expect(s.inner.goToPlayerCalls).toHaveLength(2)
  })

  it('passes following straight through, without any door handling', async () => {
    const s = setup()

    const result = await s.navigator.follow('Andrey_Knight', 3, options())

    expect(result).toEqual({ ok: true, value: undefined })
    expect(s.inner.followCalls).toEqual([{ player: 'Andrey_Knight', distance: 3 }])
    expect(s.doors.toggled).toEqual([])
  })

  it('logs, rather than fails, when a door cannot be closed behind the bot', async () => {
    const s = setup()
    const doorAt = at(5, 64, 5)
    s.doors.set(doorAt, 'oak_door', false)
    s.doors.wontCloseAt = key(doorAt) // opens fine on the way in, then refuses to close
    s.blocks.blocks = [{ name: 'oak_door', position: doorAt, distance: 3 }]
    s.inner.queue(err(unreachable), ok(target))

    const result = await s.navigator.goToPosition(target, 2, options())

    expect(result).toEqual({ ok: true, value: target })
    expect(s.logger.entries).toEqual([
      expect.objectContaining({ level: 'warn' }) as unknown,
    ])
  })
})
