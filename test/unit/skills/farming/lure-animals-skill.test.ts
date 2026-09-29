import { penGateSetup } from '../../../fakes/pen-gate-fakes.js'
import type { PenGateGuard } from '../../../../src/skills/farming/pen-gate-guard.js'
import { describe, expect, it } from '@jest/globals'
import type { AnimalInfo, AnimalScanner } from '../../../../src/core/animal-scanner.port.js'
import type {
  AnimalInteraction,
  AnimalInteractionFailure,
} from '../../../../src/core/animal-interaction.port.js'
import type { NavigationFailure, Navigator } from '../../../../src/core/navigator.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { err, ok, type Result } from '../../../../src/core/result.js'
import { LureAnimalsSkill } from '../../../../src/skills/farming/lure-animals-skill.js'
import { FarmRegistry } from '../../../../src/state/farm-registry.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { AutoScheduler } from '../../../fakes/gathering-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const context = () => ({ signal: new AbortController().signal, progress: () => undefined })

const animal = (
  overrides: Partial<AnimalInfo> & { id: number; species: string; position: Position },
): AnimalInfo => ({
  distance: 1,
  baby: false,
  named: false,
  owned: false,
  saddled: false,
  ridden: false,
  dead: false,
  ...overrides,
})

class FakeAnimalScanner implements AnimalScanner {
  animals: AnimalInfo[] = []
  /** Ids that never resolve through find() (simulates an entity gone from view). */
  readonly vanished = new Set<number>()
  nearby(): readonly AnimalInfo[] {
    return this.animals
  }
  find(id: number): AnimalInfo | undefined {
    if (this.vanished.has(id)) return undefined
    return this.animals.find((a) => a.id === id)
  }
}

class FakeInteraction implements AnimalInteraction {
  readonly held: string[] = []
  holdFailure: AnimalInteractionFailure | undefined
  hold(item: string): Promise<Result<void, AnimalInteractionFailure>> {
    this.held.push(item)
    return Promise.resolve(this.holdFailure === undefined ? ok(undefined) : err(this.holdFailure))
  }
  feed(): Promise<Result<void, AnimalInteractionFailure>> {
    return Promise.resolve(ok(undefined))
  }
}

/** Moves a shared position exactly to the target on every trip (no partial movement, like other construction fakes). */
class FakeNavigator implements Navigator {
  position: Position
  readonly calls: Position[] = []
  failNextCall: NavigationFailure | undefined
  constructor(start: Position) {
    this.position = start
  }
  goToPosition(target: Position): Promise<Result<Position, NavigationFailure>> {
    this.calls.push(target)
    if (this.failNextCall !== undefined) {
      const failure = this.failNextCall
      this.failNextCall = undefined
      return Promise.resolve(err(failure))
    }
    this.position = target
    return Promise.resolve(ok(target))
  }
  goToPlayer(): Promise<Result<Position, NavigationFailure>> {
    return Promise.resolve(ok(this.position))
  }
  follow(): Promise<Result<void, NavigationFailure>> {
    return Promise.resolve(ok(undefined))
  }
}

class FakeVitals {
  constructor(private readonly navigator: FakeNavigator) {}
  read() {
    return {
      health: 20,
      food: 20,
      saturation: 5,
      oxygen: 20,
      inLava: false,
      inWater: false,
      headUnderwater: false,
      position: this.navigator.position,
      dimension: 'overworld',
      timeOfDay: 0,
    }
  }
}

async function setup(
  start: Position = { x: 0, y: 64, z: 0 },
  gates?: PenGateGuard,
) {
  const animals = new FakeAnimalScanner()
  const interaction = new FakeInteraction()
  const navigator = new FakeNavigator(start)
  const vitals = new FakeVitals(navigator)
  const clock = new FakeClock(0)
  const farms = new FarmRegistry(clock)
  await farms.attach(new InMemoryStateStore())
  const scheduler = new AutoScheduler(clock)
  const skill = new LureAnimalsSkill({
    animals,
    interaction,
    navigator,
    vitals,
    farms,
    scheduler,
    gates,
  })
  return { animals, interaction, navigator, vitals, farms, skill, clock }
}

const at = (x: number, y: number, z: number): Position => ({ x, y, z })

describe('LureAnimalsSkill', () => {
  it('leads a wild animal to the destination, holding the right food', async () => {
    const s = await setup()
    s.animals.animals = [animal({ id: 1, species: 'cow', position: at(5, 64, 0) })]

    const result = await s.skill.run(
      { species: 'cow', count: 1, farm: undefined, destination: at(6, 64, 0), maxDistance: 32 },
      context(),
    )

    expect(result).toEqual({
      ok: true,
      value: { led: 1, requested: 1, room: 1, shortfall: 0, abandoned: [], penFull: false },
    })
    expect(s.interaction.held).toEqual(['wheat'])
  })

  it('excludes tamed, named, saddled, and ridden animals from candidates', async () => {
    const s = await setup()
    s.animals.animals = [
      animal({ id: 1, species: 'cow', position: at(5, 64, 0), owned: true }),
      animal({ id: 2, species: 'cow', position: at(5, 64, 1), named: true }),
      animal({ id: 3, species: 'cow', position: at(5, 64, 2), saddled: true }),
      animal({ id: 4, species: 'cow', position: at(5, 64, 3), ridden: true }),
    ]

    const result = await s.skill.run(
      { species: 'cow', count: 1, farm: undefined, destination: at(6, 64, 0), maxDistance: 32 },
      context(),
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_animals_nearby' } })
  })

  it('abandons an animal that vanishes from view as unreachable', async () => {
    const s = await setup()
    s.animals.animals = [animal({ id: 1, species: 'cow', position: at(5, 64, 0) })]
    s.animals.vanished.add(1)

    const result = await s.skill.run(
      { species: 'cow', count: 1, farm: undefined, destination: at(50, 64, 0), maxDistance: 32 },
      context(),
    )

    expect(result).toEqual({
      ok: true,
      value: {
        led: 0,
        requested: 1,
        room: 1,
        shortfall: 1,
        abandoned: [{ id: 1, reason: 'unreachable' }],
        penFull: false,
      },
    })
  })

  it('abandons an animal that falls far behind as lost_interest', async () => {
    const s = await setup()
    // The animal never moves; a far destination walks the bot well past the follow-lost distance from it.
    s.animals.animals = [animal({ id: 1, species: 'cow', position: at(5, 64, 0) })]

    const result = await s.skill.run(
      { species: 'cow', count: 1, farm: undefined, destination: at(50, 64, 0), maxDistance: 32 },
      context(),
    )

    expect(result).toEqual({
      ok: true,
      value: {
        led: 0,
        requested: 1,
        room: 1,
        shortfall: 1,
        abandoned: [{ id: 1, reason: 'lost_interest' }],
        penFull: false,
      },
    })
  })

  it('tries the next candidate when one is abandoned, up to count', async () => {
    const s = await setup()
    s.animals.animals = [
      animal({ id: 1, species: 'cow', position: at(5, 64, 0) }),
      animal({ id: 2, species: 'cow', position: at(6, 64, 0) }),
    ]
    s.animals.vanished.add(1)

    const result = await s.skill.run(
      { species: 'cow', count: 1, farm: undefined, destination: at(9, 64, 0), maxDistance: 32 },
      context(),
    )

    expect(result).toEqual({
      ok: true,
      value: {
        led: 1,
        requested: 1,
        room: 1,
        shortfall: 0,
        abandoned: [{ id: 1, reason: 'unreachable' }],
        penFull: false,
      },
    })
  })

  it('fails with no_animals_nearby when nothing of the species is found', async () => {
    const s = await setup()

    const result = await s.skill.run(
      { species: 'cow', count: 1, farm: undefined, destination: at(6, 64, 0), maxDistance: 32 },
      context(),
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_animals_nearby' } })
  })

  it('fails with no_food when the bot has none to lure with', async () => {
    const s = await setup()
    s.animals.animals = [animal({ id: 1, species: 'cow', position: at(5, 64, 0) })]
    s.interaction.holdFailure = { reason: 'no_item', message: 'none' }

    const result = await s.skill.run(
      { species: 'cow', count: 1, farm: undefined, destination: at(6, 64, 0), maxDistance: 32 },
      context(),
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_food' } })
  })

  it('fails with unknown_species for a species nothing here breeds', async () => {
    const s = await setup()

    const result = await s.skill.run(
      { species: 'zombie', count: 1, farm: undefined, destination: at(6, 64, 0), maxDistance: 32 },
      context(),
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'unknown_species' } })
  })

  it('fails with no_destination when neither a farm nor a destination is given', async () => {
    const s = await setup()

    const result = await s.skill.run(
      { species: 'cow', count: 1, farm: undefined, destination: undefined, maxDistance: 32 },
      context(),
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_destination' } })
  })

  it('resolves the destination as the centre of a registered pen', async () => {
    const s = await setup()
    const registered = s.farms.register({
      kind: 'pen',
      species: 'cow',
      bounds: { from: at(0, 64, 0), to: at(4, 64, 4) },
      label: 'cow pen',
    })
    if (!registered.ok) throw new Error(registered.error)
    s.animals.animals = [animal({ id: 1, species: 'cow', position: at(1, 64, 1) })]

    const result = await s.skill.run(
      { species: 'cow', count: 1, farm: 'cow pen', destination: undefined, maxDistance: 32 },
      context(),
    )

    expect(result).toMatchObject({ ok: true, value: { led: 1 } })
  })

  it('reports penFull and leads none when the destination pen is already at capacity', async () => {
    const s = await setup()
    const registered = s.farms.register({
      kind: 'pen',
      species: 'cow',
      bounds: { from: at(0, 64, 0), to: at(1, 64, 1) }, // capacity 4
      label: 'cow pen',
    })
    if (!registered.ok) throw new Error(registered.error)
    s.animals.animals = [
      animal({ id: 1, species: 'cow', position: at(0, 64, 0) }),
      animal({ id: 2, species: 'cow', position: at(0, 64, 1) }),
      animal({ id: 3, species: 'cow', position: at(1, 64, 0) }),
      animal({ id: 4, species: 'cow', position: at(1, 64, 1) }),
      animal({ id: 5, species: 'cow', position: at(20, 64, 0) }), // the wild candidate, outside the pen
    ]

    const result = await s.skill.run(
      { species: 'cow', count: 1, farm: 'cow pen', destination: undefined, maxDistance: 32 },
      context(),
    )

    expect(result).toEqual({
      ok: true,
      value: { led: 0, requested: 1, room: 0, shortfall: 1, abandoned: [], penFull: true },
    })
  })
  it('does not call the pen full when it has room for some but not all: it reports the room and the shortfall', async () => {
    const s = await setup()
    const registered = s.farms.register({
      kind: 'pen',
      species: 'cow',
      bounds: { from: at(0, 64, 0), to: at(1, 64, 1) }, // capacity 4
      label: 'cow pen',
    })
    if (!registered.ok) throw new Error(registered.error)
    s.animals.animals = [
      animal({ id: 1, species: 'cow', position: at(0, 64, 0) }),
      animal({ id: 2, species: 'cow', position: at(0, 64, 1) }),
      animal({ id: 3, species: 'cow', position: at(1, 64, 0) }),
      animal({ id: 4, species: 'cow', position: at(3, 64, 0) }),
      animal({ id: 5, species: 'cow', position: at(4, 64, 0) }),
    ]

    const result = await s.skill.run(
      { species: 'cow', count: 3, farm: 'cow pen', destination: undefined, maxDistance: 32 },
      context(),
    )

    expect(result).toMatchObject({
      ok: true,
      value: { led: 1, requested: 3, room: 1, shortfall: 2, penFull: false },
    })
  })

  it('does not call the pen full when nothing could be led although it has room', async () => {
    const s = await setup()
    const registered = s.farms.register({
      kind: 'pen',
      species: 'chicken',
      bounds: { from: at(0, 64, 0), to: at(4, 64, 4) },
      label: 'hen house',
    })
    if (!registered.ok) throw new Error(registered.error)
    s.animals.animals = [animal({ id: 1, species: 'chicken', position: at(60, 64, 0) })]
    s.animals.vanished.add(1)

    const result = await s.skill.run(
      { species: 'chicken', count: 2, farm: 'hen house', destination: undefined, maxDistance: 64 },
      context(),
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        led: 0,
        requested: 2,
        room: 2,
        shortfall: 2,
        penFull: false,
        abandoned: [{ id: 1, reason: 'unreachable' }],
      },
    })
  })

  describe('approaching and leading', () => {
    it('waits between hops for an animal that lags behind, and leads it in when it catches up', async () => {
      const s = await setup()
      s.animals.animals = [animal({ id: 1, species: 'cow', position: at(5, 64, 0) })]
      // The cow starts 8 blocks behind the bot and closes in by a block for every half second the bot waits.
      s.animals.find = (id: number) => {
        const lag = Math.max(2, 8 - s.clock.now() / 500)
        return animal({ id, species: 'cow', position: at(s.navigator.position.x - lag, 64, 0) })
      }

      const result = await s.skill.run(
        { species: 'cow', count: 1, farm: undefined, destination: at(16, 64, 0), maxDistance: 32 },
        context(),
      )

      expect(result).toMatchObject({ ok: true, value: { led: 1, abandoned: [] } })
      // It really waited for the cow: two half seconds bring an 8-block lag down to 6.
      expect(s.clock.now()).toBe(1000)
    })

    it('gives up on an animal that does not catch up within the wait, as lost_interest', async () => {
      const s = await setup()
      s.animals.animals = [animal({ id: 1, species: 'cow', position: at(5, 64, 0) })]

      const result = await s.skill.run(
        { species: 'cow', count: 1, farm: undefined, destination: at(50, 64, 0), maxDistance: 32 },
        context(),
      )

      expect(result).toMatchObject({
        ok: true,
        value: { led: 0, abandoned: [{ id: 1, reason: 'lost_interest' }] },
      })
      expect(s.clock.now()).toBeGreaterThanOrEqual(5000)
    })

    it('does not wait for an animal that is far beyond following range', async () => {
      const s = await setup()
      s.animals.animals = [animal({ id: 1, species: 'cow', position: at(5, 64, 0) })]
      // Seen close by while approaching, then left far behind at once (a burst of speed, or a gate it cannot pass).
      let reads = 0
      s.animals.find = (id: number) => {
        reads += 1
        return animal({ id, species: 'cow', position: reads === 1 ? at(5, 64, 0) : at(-30, 64, 0) })
      }

      const result = await s.skill.run(
        { species: 'cow', count: 1, farm: undefined, destination: at(50, 64, 0), maxDistance: 32 },
        context(),
      )

      expect(result).toMatchObject({
        ok: true,
        value: { abandoned: [{ reason: 'lost_interest' }] },
      })
      expect(s.clock.now()).toBe(0)
    })

    it('tries the approach again from where the animal is now when the walk fails', async () => {
      const s = await setup()
      s.animals.animals = [animal({ id: 1, species: 'cow', position: at(20, 64, 0) })]
      s.navigator.failNextCall = { reason: 'unreachable', message: 'no path' }
      let reads = 0
      s.animals.find = (id: number) => {
        reads += 1
        // The cow wandered on after the first failed walk.
        return animal({ id, species: 'cow', position: reads === 1 ? at(20, 64, 0) : at(22, 64, 3) })
      }

      const result = await s.skill.run(
        { species: 'cow', count: 1, farm: undefined, destination: at(23, 64, 3), maxDistance: 32 },
        context(),
      )

      expect(result).toMatchObject({ ok: true, value: { led: 1 } })
      expect(s.navigator.calls[0]).toEqual(at(20, 64, 0))
      expect(s.navigator.calls[1]).toEqual(at(22, 64, 3))
    })

    it('gives up after three failed approaches, as unreachable', async () => {
      const s = await setup()
      s.animals.animals = [animal({ id: 1, species: 'cow', position: at(20, 64, 0) })]
      s.navigator.goToPosition = (target: Position) => {
        s.navigator.calls.push(target)
        return Promise.resolve(err({ reason: 'unreachable', message: 'no path' }))
      }

      const result = await s.skill.run(
        { species: 'cow', count: 1, farm: undefined, destination: at(23, 64, 3), maxDistance: 32 },
        context(),
      )

      expect(result).toMatchObject({
        ok: true,
        value: { led: 0, abandoned: [{ id: 1, reason: 'unreachable' }] },
      })
      expect(s.navigator.calls).toHaveLength(3)
    })

    it('walks to a far flock in legs of at most 30 blocks, then next to the animal, before leading', async () => {
      const s = await setup()
      s.animals.animals = [animal({ id: 1, species: 'chicken', position: at(100, 64, 0) })]

      const result = await s.skill.run(
        {
          species: 'chicken',
          count: 1,
          farm: undefined,
          destination: at(98, 64, 0),
          maxDistance: 128,
        },
        context(),
      )

      expect(result).toMatchObject({ ok: true, value: { led: 1 } })
      const legs = s.navigator.calls
      // Each step is at most 30 blocks from the one before it, and the last approach lands on the animal.
      let last = at(0, 64, 0)
      for (const call of legs) {
        expect(Math.hypot(call.x - last.x, call.z - last.z)).toBeLessThanOrEqual(30.001)
        last = call
      }
      expect(s.navigator.calls).toContainEqual(at(100, 64, 0))
      expect(s.navigator.calls.length).toBeGreaterThanOrEqual(4)
    })

    it('is cancelled while waiting for the animal', async () => {
      const s = await setup()
      s.animals.animals = [animal({ id: 1, species: 'cow', position: at(5, 64, 0) })]
      const controller = new AbortController()
      const original = s.navigator.goToPosition.bind(s.navigator)
      s.navigator.goToPosition = (target: Position) => {
        const result = original(target)
        if (s.navigator.calls.length === 2) controller.abort()
        return result
      }

      const result = await s.skill.run(
        { species: 'cow', count: 1, farm: undefined, destination: at(50, 64, 0), maxDistance: 32 },
        { signal: controller.signal, progress: () => undefined },
      )

      expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    })
  })

  describe('the pen gate', () => {
    const pen = { from: at(10, 64, 10), to: at(14, 65, 14) }
    const gate = at(12, 65, 15)

    it('shuts an open pen gate when nothing could be led, and still reports the failure', async () => {
      const g = penGateSetup()
      g.doors.add(gate, true, g.blocks)
      const s = await setup(undefined, g.guard)
      const entry = s.farms.register({ kind: 'pen', species: 'cow', bounds: pen })
      if (!entry.ok) throw new Error(entry.error)

      const result = await s.skill.run(
        { species: 'cow', count: 1, farm: entry.value.id, destination: undefined, maxDistance: 32 },
        context(),
      )

      expect(result).toMatchObject({ ok: false, error: { reason: 'no_animals_nearby' } })
      expect(g.doors.stateAt(gate)?.open).toBe(false)
    })

    it('says so in the result when the gate could not be shut', async () => {
      const g = penGateSetup()
      g.doors.add(gate, true, g.blocks)
      g.doors.farFrom.add('12,65,15')
      const s = await setup(undefined, g.guard)
      const entry = s.farms.register({ kind: 'pen', species: 'cow', bounds: pen })
      if (!entry.ok) throw new Error(entry.error)
      s.animals.animals = [
        ...Array.from({ length: 25 }, (_, i) => animal({ id: i + 1, species: 'cow', position: at(12, 64, 12) })),
      ]
      const stopped = new AbortController()
      stopped.abort()

      const result = await s.skill.run(
        { species: 'cow', count: 1, farm: entry.value.id, destination: undefined, maxDistance: 32 },
        { signal: stopped.signal, progress: () => undefined },
      )

      expect(result).toMatchObject({ ok: true, value: { penFull: true, gateLeftOpen: expect.stringContaining('still open') } })
    })
  })
})
