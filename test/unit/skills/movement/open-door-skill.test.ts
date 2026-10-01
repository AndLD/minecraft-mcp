import { describe, expect, it } from '@jest/globals'
import type { DoorAccess, DoorFailure, DoorState } from '../../../../src/core/door.port.js'
import type { NavigationFailure, Navigator } from '../../../../src/core/navigator.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { err, ok, type Result } from '../../../../src/core/result.js'
import type { Vitals } from '../../../../src/core/vitals.port.js'
import { OpenDoorSkill } from '../../../../src/skills/movement/open-door-skill.js'
import type {
  IronDoorOpenFailure,
  IronDoorOpener,
  IronDoorOpenSuccess,
} from '../../../../src/skills/movement/iron-door-opener.js'
import { FakeBlockScanner, FakeVitals } from '../../../fakes/fake-ports.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })
const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`
const signal = () => new AbortController().signal
const context = () => ({ signal: signal(), progress: () => undefined })

const vitalsAt = (position: Position): Vitals => ({
  health: 20,
  food: 20,
  saturation: 5,
  oxygen: 20,
  inLava: false,
  inWater: false,
  headUnderwater: false,
  position,
  dimension: 'overworld',
  timeOfDay: 0,
})

class FakeDoorAccess implements DoorAccess {
  readonly toggled: Position[] = []
  private readonly states = new Map<string, DoorState>()
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
    if (current !== undefined) this.states.set(k, { ...current, open: !current.open })
    return Promise.resolve(ok(undefined))
  }
}

class FakeNavigator implements Navigator {
  readonly goToPositionCalls: { target: Position; within: number }[] = []
  fail: NavigationFailure | undefined
  /** Fails only the "walk through" call (within 0), leaving any earlier approach call untouched. */
  failWithin0: NavigationFailure | undefined
  goToPosition(target: Position, within: number): Promise<Result<Position, NavigationFailure>> {
    this.goToPositionCalls.push({ target, within })
    if (within === 0 && this.failWithin0 !== undefined) return Promise.resolve(err(this.failWithin0))
    return Promise.resolve(this.fail === undefined ? ok(target) : err(this.fail))
  }
  goToPlayer(): Promise<Result<Position, NavigationFailure>> {
    return Promise.resolve(ok(at(0, 0, 0)))
  }
  follow(): Promise<Result<void, NavigationFailure>> {
    return Promise.resolve(ok(undefined))
  }
}

class FakeOpener implements Pick<IronDoorOpener, 'open' | 'restoreLever'> {
  result: Result<IronDoorOpenSuccess, IronDoorOpenFailure> = err({
    reason: 'no_switches_found',
    message: 'none',
    tried: [],
  })
  readonly restoreCalls: Position[] = []
  open(): Promise<Result<IronDoorOpenSuccess, IronDoorOpenFailure>> {
    return Promise.resolve(this.result)
  }
  restoreLever(position: Position): Promise<void> {
    this.restoreCalls.push(position)
    return Promise.resolve()
  }
}

function setup() {
  const blocks = new FakeBlockScanner()
  blocks.names = ['oak_door', 'iron_door']
  const doors = new FakeDoorAccess()
  const navigator = new FakeNavigator()
  const opener = new FakeOpener()
  const vitals = new FakeVitals()
  vitals.vitals = vitalsAt(at(1, 64, 5)) // 4 blocks before the door, along z
  const skill = new OpenDoorSkill({ blocks, doors, navigator, opener: opener as unknown as IronDoorOpener, vitals })
  return { blocks, doors, navigator, opener, vitals, skill }
}

const doorAt = at(1, 64, 1)

describe('OpenDoorSkill', () => {
  it('opens a closed wooden door by hand, walks through, and closes it again', async () => {
    const s = setup()
    s.blocks.blockNames.set(key(doorAt), 'oak_door')
    s.doors.set(doorAt, 'oak_door', false)

    const result = await s.skill.run({ position: doorAt, walkThrough: true, restore: true }, context())

    expect(result).toEqual({
      ok: true,
      value: { name: 'oak_door', wasOpen: false, walkedThrough: true, restored: true, switchUsed: undefined },
    })
    expect(s.doors.toggled).toEqual([doorAt, doorAt]) // opened, then closed again
    expect(s.doors.stateAt(doorAt)?.open).toBe(false)
  })

  it('walks to a point beyond the door, continuing the line the bot was already on', async () => {
    const s = setup() // vitals at z=5, door at z=1: the bot is walking toward -z
    s.blocks.blockNames.set(key(doorAt), 'oak_door')
    s.doors.set(doorAt, 'oak_door', false)

    await s.skill.run({ position: doorAt, walkThrough: true, restore: false }, context())

    const through = s.navigator.goToPositionCalls[s.navigator.goToPositionCalls.length - 1]
    expect(through).toEqual({ target: { x: 1, y: 64, z: -3 }, within: 0 })
  })

  it('leaves the door open when restore is false', async () => {
    const s = setup()
    s.blocks.blockNames.set(key(doorAt), 'oak_door')
    s.doors.set(doorAt, 'oak_door', false)

    const result = await s.skill.run({ position: doorAt, walkThrough: true, restore: false }, context())

    expect(result).toMatchObject({ ok: true, value: { restored: false } })
    expect(s.doors.stateAt(doorAt)?.open).toBe(true)
  })

  it('does nothing to a door that is already open, but can still walk through', async () => {
    const s = setup()
    s.blocks.blockNames.set(key(doorAt), 'oak_door')
    s.doors.set(doorAt, 'oak_door', true)

    const result = await s.skill.run({ position: doorAt, walkThrough: true, restore: true }, context())

    expect(result).toMatchObject({ ok: true, value: { wasOpen: true, restored: false } })
    expect(s.doors.toggled).toEqual([]) // never touched: it was already open
  })

  it('opens an iron door through the opener and reports the switch used', async () => {
    const s = setup()
    const ironAt = at(1, 64, 1)
    s.blocks.blockNames.set(key(ironAt), 'iron_door')
    s.doors.set(ironAt, 'iron_door', false)
    const lever = { position: at(2, 64, 1), name: 'lever', kind: 'lever' as const, distance: 1 }
    s.opener.result = ok({ pressed: lever })

    const result = await s.skill.run({ position: ironAt, walkThrough: true, restore: true }, context())

    expect(result).toEqual({
      ok: true,
      value: {
        name: 'iron_door',
        wasOpen: false,
        walkedThrough: true,
        restored: true,
        switchUsed: { position: lever.position, name: lever.name, kind: lever.kind },
      },
    })
    expect(s.opener.restoreCalls).toEqual([lever.position])
  })

  it('does not restore after a button (no lever to put back)', async () => {
    const s = setup()
    const ironAt = at(1, 64, 1)
    s.blocks.blockNames.set(key(ironAt), 'iron_door')
    s.doors.set(ironAt, 'iron_door', false)
    const button = { position: at(2, 64, 1), name: 'stone_button', kind: 'button' as const, distance: 1 }
    s.opener.result = ok({ pressed: button })

    const result = await s.skill.run({ position: ironAt, walkThrough: true, restore: true }, context())

    expect(result).toMatchObject({ ok: true, value: { restored: false } })
    expect(s.opener.restoreCalls).toEqual([])
  })

  it('fails when the opener cannot get the iron door open', async () => {
    const s = setup()
    const ironAt = at(1, 64, 1)
    s.blocks.blockNames.set(key(ironAt), 'iron_door')
    s.doors.set(ironAt, 'iron_door', false)
    s.opener.result = err({ reason: 'door_did_not_open', message: 'no luck', tried: [] })

    const result = await s.skill.run({ position: ironAt, walkThrough: true, restore: true }, context())

    expect(result).toEqual({
      ok: false,
      error: { reason: 'door_did_not_open', message: 'no luck' },
    })
  })

  it('fails with not_a_door for a block that is not one', async () => {
    const s = setup()
    const wallAt = at(3, 64, 3)
    s.blocks.blockNames.set(key(wallAt), 'stone')

    const result = await s.skill.run({ position: wallAt, walkThrough: true, restore: true }, context())

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ reason: 'not_a_door' }) as unknown,
    })
  })

  it('reports a clear failure when it opened the door but could not walk through', async () => {
    const s = setup()
    s.blocks.blockNames.set(key(doorAt), 'oak_door')
    s.doors.set(doorAt, 'oak_door', false)
    s.navigator.failWithin0 = { reason: 'stuck', message: 'Not moving.' }

    const result = await s.skill.run({ position: doorAt, walkThrough: true, restore: true }, context())

    expect(result).toEqual({
      ok: false,
      error: { reason: 'stuck', message: expect.stringContaining('could not walk through') as unknown as string },
    })
  })
})
