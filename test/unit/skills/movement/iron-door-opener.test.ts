import { describe, expect, it } from '@jest/globals'
import type { DoorAccess, DoorFailure, DoorState } from '../../../../src/core/door.port.js'
import type { NavigationFailure, NavigationOptions, Navigator } from '../../../../src/core/navigator.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { err, ok, type Result } from '../../../../src/core/result.js'
import type { SwitchAccess, SwitchFailure, SwitchState } from '../../../../src/core/switch.port.js'
import { IronDoorOpener } from '../../../../src/skills/movement/iron-door-opener.js'
import { SwitchFinder } from '../../../../src/skills/movement/switch-finder.js'
import { FakeBlockScanner } from '../../../fakes/fake-ports.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })
const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`

/**
 * A shared fake world behind both ports: pressing a switch flips its own powered state and, when linked, the
 * open state of a door — the same simplification the integration-level `FakeBot` uses.
 */
class FakeSwitchDoorWorld {
  readonly pressed: Position[] = []
  private readonly switchStates = new Map<string, SwitchState>()
  private readonly doorStates = new Map<string, DoorState>()
  private readonly links = new Map<string, string>()

  setSwitch(position: Position, name: string, powered: boolean): void {
    this.switchStates.set(key(position), { name, powered })
  }

  setDoor(position: Position, name: string, open: boolean): void {
    this.doorStates.set(key(position), { name, open })
  }

  /** The door opens whenever this switch position is powered. */
  link(switchPosition: Position, doorPosition: Position): void {
    this.links.set(key(switchPosition), key(doorPosition))
  }

  switchStateAt(position: Position): SwitchState | undefined {
    return this.switchStates.get(key(position))
  }

  doorStateAt(position: Position): DoorState | undefined {
    return this.doorStates.get(key(position))
  }

  press(position: Position): Result<void, SwitchFailure> {
    this.pressed.push(position)
    const k = key(position)
    const current = this.switchStates.get(k)
    if (current === undefined) return ok(undefined)
    this.power(k, !current.powered)
    return ok(undefined)
  }

  /** Standing on a plate powers it, without a click — what `IronDoorOpener` does for `kind === 'plate'`. */
  standOn(position: Position): void {
    this.power(key(position), true)
  }

  private power(switchKey: string, powered: boolean): void {
    const current = this.switchStates.get(switchKey)
    if (current !== undefined) this.switchStates.set(switchKey, { ...current, powered })
    const doorKey = this.links.get(switchKey)
    const door = doorKey === undefined ? undefined : this.doorStates.get(doorKey)
    if (doorKey !== undefined && door !== undefined) this.doorStates.set(doorKey, { ...door, open: powered })
  }
}

/** `SwitchAccess` view of the shared world. */
class FakeSwitchAccess implements SwitchAccess {
  constructor(private readonly world: FakeSwitchDoorWorld) {}
  stateAt(position: Position): SwitchState | undefined {
    return this.world.switchStateAt(position)
  }
  press(position: Position): Promise<Result<void, SwitchFailure>> {
    return Promise.resolve(this.world.press(position))
  }
}

/** `DoorAccess` view of the shared world (only `stateAt` is exercised by `IronDoorOpener`). */
class FakeDoorAccess implements DoorAccess {
  constructor(private readonly world: FakeSwitchDoorWorld) {}
  stateAt(position: Position): DoorState | undefined {
    return this.world.doorStateAt(position)
  }
  toggle(): Promise<Result<void, DoorFailure>> {
    return Promise.resolve(ok(undefined))
  }
}

class FakeNavigator implements Navigator {
  readonly goToPositionCalls: { target: Position; within: number }[] = []
  failAt: Set<string> = new Set()
  /** Standing right on a target (within 0) is how a plate gets powered in the real game; the test wires this up. */
  onArriveAt0: ((position: Position) => void) | undefined

  goToPosition(
    target: Position,
    within: number,
    _options: NavigationOptions,
  ): Promise<Result<Position, NavigationFailure>> {
    this.goToPositionCalls.push({ target, within })
    if (this.failAt.has(key(target)))
      return Promise.resolve(err({ reason: 'unreachable', message: 'Blocked.' }))
    if (within === 0) this.onArriveAt0?.(target)
    return Promise.resolve(ok(target))
  }

  goToPlayer(): Promise<Result<Position, NavigationFailure>> {
    return Promise.resolve(ok(at(0, 0, 0)))
  }

  follow(): Promise<Result<void, NavigationFailure>> {
    return Promise.resolve(ok(undefined))
  }
}

function setup() {
  const blocks = new FakeBlockScanner()
  blocks.names = ['lever', 'stone_button', 'oak_pressure_plate', 'iron_door']
  const finder = new SwitchFinder(blocks)
  const world = new FakeSwitchDoorWorld()
  const switches = new FakeSwitchAccess(world)
  const doors = new FakeDoorAccess(world)
  const navigator = new FakeNavigator()
  navigator.onArriveAt0 = (position) => {
    world.standOn(position)
  }
  const opener = new IronDoorOpener(finder, switches, doors, navigator)
  return { blocks, finder, world, switches, doors, navigator, opener }
}

const signal = () => new AbortController().signal
const doorAt = at(0, 64, 0)
const doorName = 'iron_door'

describe('IronDoorOpener', () => {
  it('presses the nearest lever and reports success once the door reads open', async () => {
    const s = setup()
    const leverAt = at(1, 64, 0)
    s.world.setDoor(doorAt, doorName, false)
    s.world.setSwitch(leverAt, 'lever', false)
    s.world.link(leverAt, doorAt)
    s.blocks.blocks = [{ name: 'lever', position: leverAt, distance: 1 }]

    const result = await s.opener.open(doorAt, doorName, signal())

    expect(result).toEqual({
      ok: true,
      value: { pressed: expect.objectContaining({ position: leverAt }) as unknown },
    })
    expect(s.world.pressed).toEqual([leverAt])
    expect(s.doors.stateAt(doorAt)).toEqual({ name: doorName, open: true })
  })

  it('walks onto a plate instead of clicking it', async () => {
    const s = setup()
    const plateAt = at(1, 64, 0)
    s.world.setDoor(doorAt, doorName, false)
    s.world.setSwitch(plateAt, 'oak_pressure_plate', false)
    s.world.link(plateAt, doorAt)
    s.blocks.blocks = [{ name: 'oak_pressure_plate', position: plateAt, distance: 1 }]

    const result = await s.opener.open(doorAt, doorName, signal())

    expect(result.ok).toBe(true)
    expect(s.navigator.goToPositionCalls).toContainEqual({ target: plateAt, within: 0 })
    expect(s.world.pressed).toEqual([]) // a plate is never clicked
  })

  it('tries the next candidate when the nearest one does not open the door', async () => {
    const s = setup()
    const decoy = at(1, 64, 0)
    const real = at(2, 64, 0)
    s.world.setDoor(doorAt, doorName, false)
    s.world.setSwitch(decoy, 'stone_button', false) // presses fine, opens nothing (not linked)
    s.world.setSwitch(real, 'lever', false)
    s.world.link(real, doorAt)
    s.blocks.blocks = [
      { name: 'stone_button', position: decoy, distance: 1 },
      { name: 'lever', position: real, distance: 2 },
    ]

    const result = await s.opener.open(doorAt, doorName, signal())

    expect(result.ok).toBe(true)
    expect(s.world.pressed).toEqual([decoy, real])
  })

  it('fails with no_switches_found when nothing is nearby', async () => {
    const s = setup()
    s.blocks.blocks = []

    const result = await s.opener.open(doorAt, doorName, signal())

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ reason: 'no_switches_found', tried: [] }) as unknown,
    })
  })

  it('fails with door_did_not_open after trying every candidate for both rounds', async () => {
    const s = setup()
    const leverAt = at(1, 64, 0)
    s.world.setDoor(doorAt, doorName, false)
    s.world.setSwitch(leverAt, 'lever', false) // presses, but is not linked to the door
    s.blocks.blocks = [{ name: 'lever', position: leverAt, distance: 1 }]

    const result = await s.opener.open(doorAt, doorName, signal())

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ reason: 'door_did_not_open' }) as unknown,
    })
    // 1 candidate, tried across 2 rounds.
    expect(s.world.pressed).toHaveLength(2)
  })

  it('tries no more than 4 candidates per round', async () => {
    const s = setup()
    s.world.setDoor(doorAt, doorName, false)
    const positions = Array.from({ length: 6 }, (_, i) => at(i + 1, 64, 0))
    for (const p of positions) s.world.setSwitch(p, 'lever', false)
    s.blocks.blocks = positions.map((p, i) => ({ name: 'lever', position: p, distance: i + 1 }))

    await s.opener.open(doorAt, doorName, signal())

    // 4 candidates x 2 rounds = 8 presses, never touching the 5th or 6th.
    expect(s.world.pressed).toHaveLength(8)
    expect(s.world.pressed).not.toContainEqual(positions[4])
    expect(s.world.pressed).not.toContainEqual(positions[5])
  })

  it('stops at once when aborted', async () => {
    const s = setup()
    const leverAt = at(1, 64, 0)
    s.world.setDoor(doorAt, doorName, false)
    s.world.setSwitch(leverAt, 'lever', false)
    s.blocks.blocks = [{ name: 'lever', position: leverAt, distance: 1 }]
    const controller = new AbortController()
    controller.abort()

    const result = await s.opener.open(doorAt, doorName, controller.signal)

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ reason: 'aborted' }) as unknown,
    })
    expect(s.world.pressed).toEqual([])
  })

  it('restoreLever presses the lever again', async () => {
    const s = setup()
    const leverAt = at(1, 64, 0)
    s.world.setSwitch(leverAt, 'lever', true)

    await s.opener.restoreLever(leverAt, signal())

    expect(s.world.pressed).toEqual([leverAt])
  })
})
