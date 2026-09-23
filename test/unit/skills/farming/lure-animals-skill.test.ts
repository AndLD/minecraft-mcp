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
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const context = () => ({ signal: new AbortController().signal, progress: () => undefined })

const animal = (overrides: Partial<AnimalInfo> & { id: number; species: string; position: Position }): AnimalInfo => ({
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

async function setup(start: Position = { x: 0, y: 64, z: 0 }) {
  const animals = new FakeAnimalScanner()
  const interaction = new FakeInteraction()
  const navigator = new FakeNavigator(start)
  const vitals = new FakeVitals(navigator)
  const farms = new FarmRegistry(new FakeClock(0))
  await farms.attach(new InMemoryStateStore())
  const skill = new LureAnimalsSkill({ animals, interaction, navigator, vitals, farms })
  return { animals, interaction, navigator, vitals, farms, skill }
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

    expect(result).toEqual({ ok: true, value: { led: 1, requested: 1, abandoned: [], penFull: false } })
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
      value: { led: 0, requested: 1, abandoned: [{ id: 1, reason: 'unreachable' }], penFull: false },
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
      value: { led: 0, requested: 1, abandoned: [{ id: 1, reason: 'lost_interest' }], penFull: false },
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
      value: { led: 1, requested: 1, abandoned: [{ id: 1, reason: 'unreachable' }], penFull: false },
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

    expect(result).toEqual({ ok: true, value: { led: 0, requested: 1, abandoned: [], penFull: true } })
  })
})
