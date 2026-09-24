import { describe, expect, it } from '@jest/globals'
import type { MinecartFailure, MinecartPlacer } from '../../../../src/core/minecart.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { err, ok, type Result } from '../../../../src/core/result.js'
import { PlaceMinecartSkill } from '../../../../src/skills/railway/place-minecart-skill.js'
import { RailwayLog } from '../../../../src/state/railway-log.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { skillContext, InstantNavigator } from '../../../fakes/gathering-fakes.js'
import { GroveWorld } from '../../../fakes/grove-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const Y = 64
const at = (x: number, z = 0): Position => ({ x, y: Y, z })

class FakeMinecarts implements MinecartPlacer {
  readonly placed: Position[] = []
  failure: MinecartFailure | undefined
  place(rail: Position): Promise<Result<void, MinecartFailure>> {
    this.placed.push(rail)
    return Promise.resolve(this.failure === undefined ? ok(undefined) : err(this.failure))
  }
}

async function setup() {
  const world = new GroveWorld({ x0: -20, x1: 40, z0: -20, z1: 20, y0: 50, y1: 90 })
  world.ground(-20, -20, 40, 20, Y - 1)
  const navigator = new InstantNavigator()
  const minecarts = new FakeMinecarts()
  const log = new RailwayLog(new FakeClock(0))
  await log.attach(new InMemoryStateStore())
  const skill = new PlaceMinecartSkill({ blocks: world, navigator, minecarts, log })
  return { world, navigator, minecarts, log, skill }
}

const line = (label: string | undefined, x: number) => ({
  label,
  start: at(x),
  end: at(x + 10),
  layout: 'surface' as const,
  variant: 'economy' as const,
  rails: 11,
})

describe('PlaceMinecartSkill', () => {
  it('puts the cart on the rail it is given, standing beside the line rather than on it', async () => {
    const s = await setup()
    for (let x = 0; x <= 6; x += 1) s.world.set(x, Y, 0, 'rail')

    const result = await s.skill.run({ at: at(2), line: undefined }, skillContext().context)

    expect(result).toEqual({ ok: true, value: { at: at(2), line: undefined } })
    expect(s.minecarts.placed).toEqual([at(2)])
    expect(s.navigator.trips).toEqual([{ target: at(2, 2), within: 1 }])
  })

  it('tries the other side, then the line’s own axis, when the first spot is taken', async () => {
    const s = await setup()
    s.world.set(2, Y, 2, 'stone')
    s.world.set(2, Y, -2, 'stone')

    await s.skill.run({ at: at(2), line: undefined }, skillContext().context)

    expect(s.navigator.trips[0]?.target).toEqual(at(4))
  })

  it('walks up to the rail itself when there is no free place beside it', async () => {
    const s = await setup()
    const walled = new GroveWorld({ x0: 0, x1: 5, z0: 0, z1: 0, y0: 50, y1: 90 })
    walled.set(2, Y, 0, 'rail')
    const skill = new PlaceMinecartSkill({ blocks: walled, navigator: s.navigator, minecarts: s.minecarts, log: s.log })

    await skill.run({ at: at(2), line: undefined }, skillContext().context)

    expect(s.navigator.trips).toEqual([{ target: at(2), within: 3 }])
  })

  it('goes to the start of a named line, and to the start of the last one built by default', async () => {
    const s = await setup()
    s.log.add(line('mine line', 5))
    s.log.add(line('home line', 15))

    const named = await s.skill.run({ at: undefined, line: 'MINE line' }, skillContext().context)
    const latest = await s.skill.run({ at: undefined, line: undefined }, skillContext().context)

    expect(named).toEqual({ ok: true, value: { at: at(5), line: 'railway-1' } })
    expect(latest).toEqual({ ok: true, value: { at: at(15), line: 'railway-2' } })
  })

  it('says when a railway is not known', async () => {
    const s = await setup()

    const result = await s.skill.run({ at: undefined, line: 'nowhere' }, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'unknown_railway' } })
  })

  it('falls back to the nearest rail, and says when there is none', async () => {
    const s = await setup()
    const none = await s.skill.run({ at: undefined, line: undefined }, skillContext().context)
    s.world.set(9, Y, 3, 'powered_rail')
    s.world.origin = at(0)
    const found = await s.skill.run({ at: undefined, line: undefined }, skillContext().context)

    expect(none).toMatchObject({ ok: false, error: { reason: 'no_rail' } })
    expect(found).toEqual({ ok: true, value: { at: at(9, 3), line: undefined } })
  })

  it('reports a failed walk, a cancelled one, and a failed placement', async () => {
    const s = await setup()
    s.navigator.failures = [{ reason: 'unreachable', message: 'no path' }]
    const unreachable = await s.skill.run({ at: at(2), line: undefined }, skillContext().context)
    const { context, controller } = skillContext()
    controller.abort()
    const cancelled = await s.skill.run({ at: at(2), line: undefined }, context)
    s.minecarts.failure = { reason: 'no_minecart', message: 'The bot has no minecart to place.' }
    const empty = await s.skill.run({ at: at(2), line: undefined }, skillContext().context)

    expect(unreachable).toMatchObject({ ok: false, error: { reason: 'unreachable' } })
    expect(cancelled).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(empty).toMatchObject({ ok: false, error: { reason: 'no_minecart' } })
  })
})
