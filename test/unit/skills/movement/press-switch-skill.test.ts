import { describe, expect, it } from '@jest/globals'
import type { DoorAccess, DoorFailure, DoorState } from '../../../../src/core/door.port.js'
import type { NavigationFailure, Navigator } from '../../../../src/core/navigator.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { err, ok, type Result } from '../../../../src/core/result.js'
import type { SwitchAccess, SwitchFailure, SwitchState } from '../../../../src/core/switch.port.js'
import { PressSwitchSkill } from '../../../../src/skills/movement/press-switch-skill.js'
import { FakeBlockScanner } from '../../../fakes/fake-ports.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })
const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`
const signal = () => new AbortController().signal
const context = () => ({ signal: signal(), progress: () => undefined })

class FakeSwitchAccess implements SwitchAccess {
  readonly pressed: Position[] = []
  private readonly states = new Map<string, SwitchState>()
  set(position: Position, name: string, powered: boolean): void {
    this.states.set(key(position), { name, powered })
  }
  stateAt(position: Position): SwitchState | undefined {
    return this.states.get(key(position))
  }
  press(position: Position): Promise<Result<void, SwitchFailure>> {
    this.pressed.push(position)
    return Promise.resolve(ok(undefined))
  }
}

class FakeDoorAccess implements DoorAccess {
  private readonly states = new Map<string, DoorState>()
  set(position: Position, name: string, open: boolean): void {
    this.states.set(key(position), { name, open })
  }
  stateAt(position: Position): DoorState | undefined {
    return this.states.get(key(position))
  }
  toggle(): Promise<Result<void, DoorFailure>> {
    return Promise.resolve(ok(undefined))
  }
}

class FakeNavigator implements Navigator {
  readonly goToPositionCalls: { target: Position; within: number }[] = []
  fail: NavigationFailure | undefined
  goToPosition(target: Position, within: number): Promise<Result<Position, NavigationFailure>> {
    this.goToPositionCalls.push({ target, within })
    return Promise.resolve(this.fail === undefined ? ok(target) : err(this.fail))
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
  blocks.names = ['lever', 'stone_button', 'oak_pressure_plate', 'oak_door']
  const switches = new FakeSwitchAccess()
  const doors = new FakeDoorAccess()
  const navigator = new FakeNavigator()
  const skill = new PressSwitchSkill({ blocks, switches, doors, navigator })
  return { blocks, switches, doors, navigator, skill }
}

describe('PressSwitchSkill', () => {
  it('walks to a lever, clicks it, and reports no nearby door', async () => {
    const s = setup()
    const leverAt = at(1, 64, 0)
    s.blocks.blockNames.set(key(leverAt), 'lever')

    const result = await s.skill.run({ position: leverAt }, context())

    expect(result).toEqual({
      ok: true,
      value: { pressed: { position: leverAt, name: 'lever', kind: 'lever' }, door: undefined },
    })
    expect(s.switches.pressed).toEqual([leverAt])
    expect(s.navigator.goToPositionCalls).toEqual([{ target: leverAt, within: 3 }])
  })

  it('walks onto a plate without clicking it', async () => {
    const s = setup()
    const plateAt = at(1, 64, 0)
    s.blocks.blockNames.set(key(plateAt), 'oak_pressure_plate')

    const result = await s.skill.run({ position: plateAt }, context())

    expect(result.ok).toBe(true)
    expect(s.navigator.goToPositionCalls).toEqual([{ target: plateAt, within: 0 }])
    expect(s.switches.pressed).toEqual([])
  })

  it('reports the nearest door within reach and its state', async () => {
    const s = setup()
    const buttonAt = at(1, 64, 0)
    const doorAt = at(2, 64, 0)
    s.blocks.blockNames.set(key(buttonAt), 'stone_button')
    s.blocks.blocks = [{ name: 'oak_door', position: doorAt, distance: 1 }]
    s.doors.set(doorAt, 'oak_door', true)

    const result = await s.skill.run({ position: buttonAt }, context())

    expect(result).toEqual({
      ok: true,
      value: {
        pressed: { position: buttonAt, name: 'stone_button', kind: 'button' },
        door: { position: doorAt, name: 'oak_door', open: true },
      },
    })
  })

  it('fails with not_a_switch for a block that is not one', async () => {
    const s = setup()
    const wallAt = at(1, 64, 0)
    s.blocks.blockNames.set(key(wallAt), 'stone')

    const result = await s.skill.run({ position: wallAt }, context())

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ reason: 'not_a_switch' }) as unknown,
    })
    expect(s.switches.pressed).toEqual([])
  })

  it('reports a navigation failure when the bot cannot get there', async () => {
    const s = setup()
    const leverAt = at(1, 64, 0)
    s.blocks.blockNames.set(key(leverAt), 'lever')
    s.navigator.fail = { reason: 'unreachable', message: 'No path.' }

    const result = await s.skill.run({ position: leverAt }, context())

    expect(result).toEqual({
      ok: false,
      error: { reason: 'unreachable', message: 'No path.' },
    })
    expect(s.switches.pressed).toEqual([])
  })
})
