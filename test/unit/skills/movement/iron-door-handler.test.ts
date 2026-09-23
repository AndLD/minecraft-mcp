import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { err, ok, type Result } from '../../../../src/core/result.js'
import type { SwitchPolicy } from '../../../../src/state/switch-policy.js'
import { PolicyIronDoorHandler } from '../../../../src/skills/movement/iron-door-handler.js'
import type {
  IronDoorOpenFailure,
  IronDoorOpener,
  IronDoorOpenSuccess,
} from '../../../../src/skills/movement/iron-door-opener.js'
import type { SwitchCandidate, SwitchFinder } from '../../../../src/skills/movement/switch-finder.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })
const doorAt = at(0, 64, 0)
const doorName = 'iron_door'
const signal = () => new AbortController().signal

class FakePolicy implements Pick<SwitchPolicy, 'get'> {
  mode: 'ask' | 'auto' | 'never' = 'ask'
  get() {
    return this.mode
  }
}

class FakeFinder implements Pick<SwitchFinder, 'near'> {
  candidates: readonly SwitchCandidate[] = []
  near(): readonly SwitchCandidate[] {
    return this.candidates
  }
}

class FakeOpener implements Pick<IronDoorOpener, 'open' | 'restoreLever'> {
  openResult: Result<IronDoorOpenSuccess, IronDoorOpenFailure> = err({
    reason: 'no_switches_found',
    message: 'none',
    tried: [],
  })
  readonly restoreCalls: Position[] = []
  open(): Promise<Result<IronDoorOpenSuccess, IronDoorOpenFailure>> {
    return Promise.resolve(this.openResult)
  }
  restoreLever(position: Position): Promise<void> {
    this.restoreCalls.push(position)
    return Promise.resolve()
  }
}

const leverCandidate: SwitchCandidate = {
  position: at(1, 64, 0),
  name: 'lever',
  kind: 'lever',
  distance: 1,
}

function setup() {
  const policy = new FakePolicy()
  const finder = new FakeFinder()
  const opener = new FakeOpener()
  const handler = new PolicyIronDoorHandler(
    policy as unknown as SwitchPolicy,
    finder as unknown as SwitchFinder,
    opener as unknown as IronDoorOpener,
  )
  return { policy, finder, opener, handler }
}

describe('PolicyIronDoorHandler', () => {
  it('never mode always reports needs_switch without searching or pressing anything', async () => {
    const s = setup()
    s.policy.mode = 'never'
    s.finder.candidates = [leverCandidate]

    const result = await s.handler.open(doorAt, doorName, signal())

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ reason: 'needs_switch' }) as unknown,
    })
  })

  it('ask mode reports iron_door_blocked with the candidates found, and presses nothing', async () => {
    const s = setup()
    s.policy.mode = 'ask'
    s.finder.candidates = [leverCandidate]

    const result = await s.handler.open(doorAt, doorName, signal())

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.reason).toBe('iron_door_blocked')
      expect(result.error.message).toContain('lever')
    }
  })

  it('ask mode falls back to needs_switch when nothing is found nearby', async () => {
    const s = setup()
    s.policy.mode = 'ask'
    s.finder.candidates = []

    const result = await s.handler.open(doorAt, doorName, signal())

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ reason: 'needs_switch' }) as unknown,
    })
  })

  it('auto mode presses switches through the opener and succeeds, naming the lever to restore', async () => {
    const s = setup()
    s.policy.mode = 'auto'
    s.opener.openResult = ok({ pressed: leverCandidate })

    const result = await s.handler.open(doorAt, doorName, signal())

    expect(result).toEqual({ ok: true, value: { leverToRestore: leverCandidate.position } })
  })

  it('auto mode with a button used does not ask for a restore', async () => {
    const s = setup()
    s.policy.mode = 'auto'
    s.opener.openResult = ok({
      pressed: { position: at(1, 64, 0), name: 'stone_button', kind: 'button', distance: 1 },
    })

    const result = await s.handler.open(doorAt, doorName, signal())

    expect(result).toEqual({ ok: true, value: { leverToRestore: undefined } })
  })

  it('auto mode reports needs_switch when the opener could not get the door open', async () => {
    const s = setup()
    s.policy.mode = 'auto'
    s.opener.openResult = err({ reason: 'door_did_not_open', message: 'no luck', tried: [leverCandidate] })

    const result = await s.handler.open(doorAt, doorName, signal())

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ reason: 'needs_switch' }) as unknown,
    })
  })

  it('restoreLever delegates to the opener', async () => {
    const s = setup()
    const leverAt = at(1, 64, 0)

    await s.handler.restoreLever(leverAt, signal())

    expect(s.opener.restoreCalls).toEqual([leverAt])
  })
})
