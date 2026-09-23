import { describe, expect, it } from '@jest/globals'
import type { AnimalInfo, AnimalScanner } from '../../../../src/core/animal-scanner.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { ok } from '../../../../src/core/result.js'
import type { BreedAnimalsSkill } from '../../../../src/skills/farming/breed-animals-skill.js'
import { HerdManager } from '../../../../src/skills/farming/herd-manager.js'
import type { HuntAnimalsSkill } from '../../../../src/skills/hunting/hunt-animals-skill.js'

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
  nearby(): readonly AnimalInfo[] {
    return this.animals
  }
  find(id: number): AnimalInfo | undefined {
    return this.animals.find((a) => a.id === id)
  }
}

class FakeBreed implements Pick<BreedAnimalsSkill, 'run'> {
  readonly calls: unknown[] = []
  result: Awaited<ReturnType<BreedAnimalsSkill['run']>> = ok({
    bred: 1,
    pairsFed: 1,
    herdSize: 3,
    targetCount: 6,
  })
  run(input: unknown) {
    this.calls.push(input)
    return Promise.resolve(this.result)
  }
}

class FakeHunt implements Pick<HuntAnimalsSkill, 'run'> {
  readonly calls: unknown[] = []
  result: Awaited<ReturnType<HuntAnimalsSkill['run']>> = ok({
    killed: 2,
    goal: { kind: 'animals', count: 2 },
    gained: [],
    speciesBefore: {},
    speciesAfter: {},
    cooked: [],
  })
  run(input: unknown) {
    this.calls.push(input)
    return Promise.resolve(this.result)
  }
}

function setup() {
  const animals = new FakeAnimalScanner()
  const breed = new FakeBreed()
  const hunt = new FakeHunt()
  const herd = new HerdManager({
    animals,
    breed: breed as unknown as BreedAnimalsSkill,
    hunt: hunt as unknown as HuntAnimalsSkill,
  })
  return { animals, breed, hunt, herd }
}

const bounds = { from: at(0, 64, 0), to: at(4, 64, 4) }

describe('HerdManager', () => {
  it('breeds up when the herd is below the target', async () => {
    const s = setup()
    s.animals.animals = [
      animal({ id: 1, species: 'cow', position: at(0, 64, 0) }),
      animal({ id: 2, species: 'cow', position: at(1, 64, 0) }),
    ]

    const result = await s.herd.run({ species: 'cow', targetSize: 6, bounds }, context())

    expect(result).toEqual({
      ok: true,
      value: {
        action: 'bred',
        herdSizeBefore: 2,
        bred: { bred: 1, pairsFed: 1, herdSize: 3, targetCount: 6 },
        culled: undefined,
      },
    })
    expect(s.breed.calls).toEqual([{ species: 'cow', farm: undefined, area: bounds, targetCount: 6 }])
    expect(s.hunt.calls).toEqual([])
  })

  it('culls the surplus with hunt_animals when the herd is over the target', async () => {
    const s = setup()
    s.animals.animals = [
      animal({ id: 1, species: 'cow', position: at(0, 64, 0) }),
      animal({ id: 2, species: 'cow', position: at(1, 64, 0) }),
      animal({ id: 3, species: 'cow', position: at(2, 64, 0) }),
      animal({ id: 4, species: 'cow', position: at(3, 64, 0) }),
    ]

    const result = await s.herd.run({ species: 'cow', targetSize: 2, bounds }, context())

    expect(result).toMatchObject({ ok: true, value: { action: 'culled', herdSizeBefore: 4 } })
    expect(s.breed.calls).toEqual([])
    expect(s.hunt.calls).toEqual([
      {
        species: ['cow'],
        goal: { kind: 'animals', count: 2 },
        radius: expect.any(Number),
        keepBreeders: true,
        allowBabies: false,
        includePens: true,
        cook: false,
        timeLimitMs: expect.any(Number),
      },
    ])
  })

  it('does nothing when the herd already matches the target', async () => {
    const s = setup()
    s.animals.animals = [
      animal({ id: 1, species: 'cow', position: at(0, 64, 0) }),
      animal({ id: 2, species: 'cow', position: at(1, 64, 0) }),
    ]

    const result = await s.herd.run({ species: 'cow', targetSize: 2, bounds }, context())

    expect(result).toEqual({
      ok: true,
      value: { action: 'none', herdSizeBefore: 2, bred: undefined, culled: undefined },
    })
    expect(s.breed.calls).toEqual([])
    expect(s.hunt.calls).toEqual([])
  })

  it('only counts the right species inside the bounds', async () => {
    const s = setup()
    s.animals.animals = [
      animal({ id: 1, species: 'cow', position: at(0, 64, 0) }),
      animal({ id: 2, species: 'pig', position: at(1, 64, 0) }), // wrong species
      animal({ id: 3, species: 'cow', position: at(100, 64, 0) }), // outside bounds
    ]

    const result = await s.herd.run({ species: 'cow', targetSize: 5, bounds }, context())

    expect(result).toMatchObject({ ok: true, value: { herdSizeBefore: 1 } })
  })
})
