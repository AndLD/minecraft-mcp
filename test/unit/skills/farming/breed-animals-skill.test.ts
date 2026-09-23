import { describe, expect, it } from '@jest/globals'
import type { AnimalInfo, AnimalScanner } from '../../../../src/core/animal-scanner.port.js'
import type {
  AnimalInteraction,
  AnimalInteractionFailure,
} from '../../../../src/core/animal-interaction.port.js'
import type { NavigationFailure, Navigator } from '../../../../src/core/navigator.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { err, ok, type Result } from '../../../../src/core/result.js'
import { BreedAnimalsSkill } from '../../../../src/skills/farming/breed-animals-skill.js'
import { FarmRegistry } from '../../../../src/state/farm-registry.js'
import { AutoScheduler } from '../../../fakes/gathering-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const context = () => ({ signal: new AbortController().signal, progress: () => undefined })
const at = (x: number, y: number, z: number): Position => ({ x, y, z })

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
  /** Adds this baby the first time nearby() is called after the condition becomes true (simulates one appearing while waiting). */
  spawnBabyWhen: { readonly condition: () => boolean; readonly baby: AnimalInfo } | undefined
  private spawned = false
  nearby(): readonly AnimalInfo[] {
    if (!this.spawned && this.spawnBabyWhen?.condition() === true) {
      this.spawned = true
      this.animals = [...this.animals, this.spawnBabyWhen.baby]
    }
    return this.animals
  }
  find(id: number): AnimalInfo | undefined {
    return this.animals.find((a) => a.id === id)
  }
}

class FakeInteraction implements AnimalInteraction {
  readonly held: string[] = []
  readonly fed: number[] = []
  holdFailure: AnimalInteractionFailure | undefined
  hold(item: string): Promise<Result<void, AnimalInteractionFailure>> {
    this.held.push(item)
    return Promise.resolve(this.holdFailure === undefined ? ok(undefined) : err(this.holdFailure))
  }
  feed(entityId: number): Promise<Result<void, AnimalInteractionFailure>> {
    this.fed.push(entityId)
    return Promise.resolve(ok(undefined))
  }
}

class FakeNavigator implements Navigator {
  readonly calls: Position[] = []
  goToPosition(target: Position): Promise<Result<Position, NavigationFailure>> {
    this.calls.push(target)
    return Promise.resolve(ok(target))
  }
  goToPlayer(): Promise<Result<Position, NavigationFailure>> {
    return Promise.resolve(ok(at(0, 0, 0)))
  }
  follow(): Promise<Result<void, NavigationFailure>> {
    return Promise.resolve(ok(undefined))
  }
}

async function setup() {
  const animals = new FakeAnimalScanner()
  const interaction = new FakeInteraction()
  const navigator = new FakeNavigator()
  const clock = new FakeClock(0)
  const scheduler = new AutoScheduler(clock)
  const farms = new FarmRegistry(clock)
  await farms.attach(new InMemoryStateStore())
  const skill = new BreedAnimalsSkill({ animals, interaction, navigator, clock, scheduler, farms })
  return { animals, interaction, navigator, clock, farms, skill }
}

const bounds = { from: at(0, 64, 0), to: at(4, 64, 4) }

describe('BreedAnimalsSkill', () => {
  it('feeds a pair and counts a baby that appears while waiting', async () => {
    const s = await setup()
    s.animals.animals = [
      animal({ id: 1, species: 'cow', position: at(0, 64, 0) }),
      animal({ id: 2, species: 'cow', position: at(1, 64, 0) }),
    ]
    s.animals.spawnBabyWhen = {
      condition: () => s.interaction.fed.length >= 2,
      baby: animal({ id: 3, species: 'cow', position: at(0, 64, 1), baby: true }),
    }

    const result = await s.skill.run(
      { species: 'cow', farm: undefined, area: bounds, targetCount: 3 },
      context(),
    )

    expect(result).toEqual({
      ok: true,
      value: { bred: 1, pairsFed: 1, herdSize: 3, targetCount: 3 },
    })
    expect(s.interaction.held).toEqual(['wheat'])
    expect(s.interaction.fed.sort()).toEqual([1, 2])
  })

  it('stops immediately when the herd already meets the target', async () => {
    const s = await setup()
    s.animals.animals = [
      animal({ id: 1, species: 'cow', position: at(0, 64, 0) }),
      animal({ id: 2, species: 'cow', position: at(1, 64, 0) }),
    ]

    const result = await s.skill.run(
      { species: 'cow', farm: undefined, area: bounds, targetCount: 2 },
      context(),
    )

    expect(result).toEqual({ ok: true, value: { bred: 0, pairsFed: 0, herdSize: 2, targetCount: 2 } })
    expect(s.interaction.fed).toEqual([])
  })

  it('stops when there are not enough eligible adults for a pair', async () => {
    const s = await setup()
    s.animals.animals = [
      animal({ id: 1, species: 'cow', position: at(0, 64, 0) }),
      animal({ id: 2, species: 'cow', position: at(1, 64, 0), owned: true }), // tamed: excluded
    ]

    const result = await s.skill.run(
      { species: 'cow', farm: undefined, area: bounds, targetCount: 6 },
      context(),
    )

    expect(result).toEqual({ ok: true, value: { bred: 0, pairsFed: 0, herdSize: 2, targetCount: 6 } })
    expect(s.interaction.fed).toEqual([])
  })

  it('never breeds a named, saddled, or ridden animal', async () => {
    const s = await setup()
    s.animals.animals = [
      animal({ id: 1, species: 'cow', position: at(0, 64, 0), named: true }),
      animal({ id: 2, species: 'cow', position: at(1, 64, 0), saddled: true }),
      animal({ id: 3, species: 'cow', position: at(2, 64, 0), ridden: true }),
    ]

    const result = await s.skill.run(
      { species: 'cow', farm: undefined, area: bounds, targetCount: 6 },
      context(),
    )

    expect(result).toEqual({ ok: true, value: { bred: 0, pairsFed: 0, herdSize: 3, targetCount: 6 } })
    expect(s.interaction.fed).toEqual([])
  })

  it('ignores animals outside the area', async () => {
    const s = await setup()
    s.animals.animals = [
      animal({ id: 1, species: 'cow', position: at(0, 64, 0) }),
      animal({ id: 2, species: 'cow', position: at(100, 64, 0) }),
    ]

    const result = await s.skill.run(
      { species: 'cow', farm: undefined, area: bounds, targetCount: 6 },
      context(),
    )

    expect(result).toMatchObject({ ok: true, value: { herdSize: 1, pairsFed: 0 } })
  })

  it('fails with no_food when the bot has none to breed with', async () => {
    const s = await setup()
    s.animals.animals = [
      animal({ id: 1, species: 'cow', position: at(0, 64, 0) }),
      animal({ id: 2, species: 'cow', position: at(1, 64, 0) }),
    ]
    s.interaction.holdFailure = { reason: 'no_item', message: 'none' }

    const result = await s.skill.run(
      { species: 'cow', farm: undefined, area: bounds, targetCount: 6 },
      context(),
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_food' } })
  })

  it('fails with unknown_species for a species nothing here breeds', async () => {
    const s = await setup()

    const result = await s.skill.run(
      { species: 'zombie', farm: undefined, area: bounds, targetCount: 6 },
      context(),
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'unknown_species' } })
  })

  it('fails with no_area when neither a farm nor an area is given', async () => {
    const s = await setup()

    const result = await s.skill.run(
      { species: 'cow', farm: undefined, area: undefined, targetCount: 6 },
      context(),
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_area' } })
  })

  it('resolves the area from a registered farm', async () => {
    const s = await setup()
    const registered = s.farms.register({ kind: 'pen', species: 'cow', bounds, label: 'cow pen' })
    if (!registered.ok) throw new Error(registered.error)
    s.animals.animals = [
      animal({ id: 1, species: 'cow', position: at(0, 64, 0) }),
      animal({ id: 2, species: 'cow', position: at(1, 64, 0) }),
    ]

    const result = await s.skill.run(
      { species: 'cow', farm: 'cow pen', area: undefined, targetCount: 2 },
      context(),
    )

    expect(result).toMatchObject({ ok: true, value: { herdSize: 2 } })
  })
})
