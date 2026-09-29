import { describe, expect, it } from '@jest/globals'
import { err, ok } from '../../../../src/core/result.js'
import type { CollectEggsSkill } from '../../../../src/skills/farming/collect-eggs-skill.js'
import type { HarvestCropsSkill } from '../../../../src/skills/farming/harvest-crops-skill.js'
import type { HerdManager } from '../../../../src/skills/farming/herd-manager.js'
import type { PlantCropsSkill } from '../../../../src/skills/farming/plant-crops-skill.js'
import type { PlantTreesSkill } from '../../../../src/skills/farming/plant-trees-skill.js'
import { TendFarmSkill } from '../../../../src/skills/farming/tend-farm-skill.js'
import { FarmRegistry } from '../../../../src/state/farm-registry.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const context = () => ({ signal: new AbortController().signal, progress: () => undefined })

class FakeHarvest implements Pick<HarvestCropsSkill, 'run'> {
  readonly calls: unknown[] = []
  result: Awaited<ReturnType<HarvestCropsSkill['run']>> = ok({ harvested: 3, replanted: 2 })
  run(input: unknown) {
    this.calls.push(input)
    return Promise.resolve(this.result)
  }
}

class FakePlant implements Pick<PlantCropsSkill, 'run'> {
  readonly calls: unknown[] = []
  result: Awaited<ReturnType<PlantCropsSkill['run']>> = ok({
    planted: 1,
    tilled: 0,
    skipped: 0,
    repaired: 0,
    stillBare: 0,
  })
  run(input: unknown) {
    this.calls.push(input)
    return Promise.resolve(this.result)
  }
}

class FakeHerd implements Pick<HerdManager, 'run'> {
  readonly calls: unknown[] = []
  result: Awaited<ReturnType<HerdManager['run']>> = ok({
    action: 'bred',
    herdSizeBefore: 4,
    bred: { bred: 1, pairsFed: 1, herdSize: 5, targetCount: 6 },
    culled: undefined,
  })
  run(input: unknown) {
    this.calls.push(input)
    return Promise.resolve(this.result)
  }
}

class FakeCollectEggs implements Pick<CollectEggsSkill, 'run'> {
  readonly calls: unknown[] = []
  result: Awaited<ReturnType<CollectEggsSkill['run']>> = ok({
    pickedUp: 10,
    stored: 1,
    released: 9,
    penFull: false,
  })
  run(input: unknown) {
    this.calls.push(input)
    return Promise.resolve(this.result)
  }
}

class FakePlantTrees implements Pick<PlantTreesSkill, 'run'> {
  readonly calls: unknown[] = []
  result: Awaited<ReturnType<PlantTreesSkill['run']>> = ok({
    mode: 'replant',
    species: 'oak',
    requested: 2,
    planted: 2,
    skipped: 0,
    saplingsMissing: 0,
    spots: [],
    capacity: undefined,
    rejected: undefined,
    farm: 'farm-1',
    protectedArea: false,
  })
  run(input: unknown) {
    this.calls.push(input)
    return Promise.resolve(this.result)
  }
}

async function setup(withCollectEggs = false, withPlantTrees = false) {
  const farms = new FarmRegistry(new FakeClock(0))
  await farms.attach(new InMemoryStateStore())
  const harvest = new FakeHarvest()
  const plant = new FakePlant()
  const herd = new FakeHerd()
  const collectEggs = new FakeCollectEggs()
  const plantTrees = new FakePlantTrees()
  const skill = new TendFarmSkill({
    farms,
    harvest: harvest as unknown as HarvestCropsSkill,
    plant: plant as unknown as PlantCropsSkill,
    herd: herd as unknown as HerdManager,
    collectEggs: withCollectEggs ? (collectEggs as unknown as CollectEggsSkill) : undefined,
    plantTrees: withPlantTrees ? (plantTrees as unknown as PlantTreesSkill) : undefined,
  })
  return { farms, harvest, plant, herd, collectEggs, plantTrees, skill }
}

const bounds = { from: { x: 0, y: 64, z: 0 }, to: { x: 2, y: 64, z: 2 } }

describe('TendFarmSkill', () => {
  it('harvests, replants, and plants any empty plots for one field', async () => {
    const s = await setup()
    const entry = s.farms.register({ kind: 'field', crop: 'wheat', bounds })
    if (!entry.ok) throw new Error(entry.error)

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result).toEqual({
      ok: true,
      value: {
        components: [
          {
            id: entry.value.id,
            kind: 'field',
            harvested: 3,
            replanted: 2,
            planted: 1,
            repaired: 0,
            stillBare: 0,
            herdSizeBefore: undefined,
            herdAction: undefined,
            eggsPickedUp: undefined,
            eggsStored: undefined,
            eggsReleased: undefined,
            problem: undefined,
          },
        ],
      },
    })
    expect(s.harvest.calls).toEqual([{ farm: entry.value.id, area: undefined, replant: true }])
    expect(s.plant.calls).toEqual([
      { farm: entry.value.id, area: undefined, crop: 'wheat', maxPlants: undefined },
    ])
  })

  it('keeps a pen at its herd target through HerdManager', async () => {
    const s = await setup()
    const entry = s.farms.register({ kind: 'pen', species: 'cow', herdTarget: 6, bounds })
    if (!entry.ok) throw new Error(entry.error)

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result).toEqual({
      ok: true,
      value: {
        components: [
          {
            id: entry.value.id,
            kind: 'pen',
            harvested: 0,
            replanted: 0,
            planted: 0,
            herdSizeBefore: 4,
            herdAction: 'bred',
            eggsPickedUp: undefined,
            eggsStored: undefined,
            eggsReleased: undefined,
            problem: undefined,
          },
        ],
      },
    })
    expect(s.herd.calls).toEqual([{ species: 'cow', targetSize: 6, bounds }])
  })

  it('does not collect eggs for a cow pen, even when CollectEggsSkill is wired', async () => {
    const s = await setup(true)
    const entry = s.farms.register({ kind: 'pen', species: 'cow', herdTarget: 6, bounds })
    if (!entry.ok) throw new Error(entry.error)

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.components[0]).toMatchObject({
      eggsPickedUp: undefined,
      eggsStored: undefined,
      eggsReleased: undefined,
    })
    expect(s.collectEggs.calls).toEqual([])
  })

  it('collects eggs for a chicken pen and merges the counts into the result', async () => {
    const s = await setup(true)
    const entry = s.farms.register({ kind: 'pen', species: 'chicken', herdTarget: 6, bounds })
    if (!entry.ok) throw new Error(entry.error)

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.components[0]).toMatchObject({
      herdAction: 'bred',
      eggsPickedUp: 10,
      eggsStored: 1,
      eggsReleased: 9,
      problem: undefined,
    })
    expect(s.collectEggs.calls).toEqual([
      {
        farm: entry.value.id,
        area: undefined,
        storeFraction: undefined,
        release: undefined,
        maxChickens: 6,
      },
    ])
  })

  it('does not collect eggs for a chicken pen when CollectEggsSkill is not wired', async () => {
    const s = await setup(false)
    const entry = s.farms.register({ kind: 'pen', species: 'chicken', herdTarget: 6, bounds })
    if (!entry.ok) throw new Error(entry.error)

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.components[0]).toMatchObject({
      eggsPickedUp: undefined,
      eggsStored: undefined,
      eggsReleased: undefined,
    })
  })

  it('reports an egg-collection failure only when herding itself succeeded', async () => {
    const s = await setup(true)
    const entry = s.farms.register({ kind: 'pen', species: 'chicken', herdTarget: 6, bounds })
    if (!entry.ok) throw new Error(entry.error)
    s.collectEggs.result = err({ reason: 'no_area', message: 'no eggs here' })

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.components[0]).toMatchObject({ problem: 'no eggs here' })
  })

  it("reports herding's own failure, not the egg-collection failure, when both fail", async () => {
    const s = await setup(true)
    const entry = s.farms.register({ kind: 'pen', species: 'chicken', herdTarget: 6, bounds })
    if (!entry.ok) throw new Error(entry.error)
    s.herd.result = err({ reason: 'no_food', message: 'out of seeds' })
    s.collectEggs.result = err({ reason: 'no_area', message: 'no eggs here' })

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.components[0]).toMatchObject({ problem: 'out of seeds' })
  })

  it('reports a pen with no species or herd target set, without calling HerdManager', async () => {
    const s = await setup()
    const entry = s.farms.register({ kind: 'pen', bounds })
    if (!entry.ok) throw new Error(entry.error)

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.components[0]).toMatchObject({
      problem: 'no species or herd target set for this pen (see build_farm/register_farm).',
    })
    expect(s.herd.calls).toEqual([])
  })

  it('tends every field in a group, one summary per component', async () => {
    const s = await setup()
    const a = s.farms.register({ kind: 'field', crop: 'wheat', bounds, group: 'home' })
    const b = s.farms.register({ kind: 'field', crop: 'carrots', bounds, group: 'home' })
    if (!a.ok || !b.ok) throw new Error('setup failed')

    const result = await s.skill.run({ farm: 'home' }, context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.components).toHaveLength(2)
  })

  it('reports a grove component as not yet tended, without failing the rest', async () => {
    const s = await setup()
    const grove = s.farms.register({ kind: 'grove', bounds, group: 'home' })
    const field = s.farms.register({ kind: 'field', crop: 'wheat', bounds, group: 'home' })
    if (!grove.ok || !field.ok) throw new Error('setup failed')

    const result = await s.skill.run({ farm: 'home' }, context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const groveResult = result.value.components.find((c) => c.kind === 'grove')
    expect(groveResult?.problem).toBe('grove is not tended yet.')
    const fieldResult = result.value.components.find((c) => c.kind === 'field')
    expect(fieldResult?.harvested).toBe(3)
  })

  it('refills the empty spots of a grove, never felling, and reports the saplings planted', async () => {
    const s = await setup(false, true)
    const entry = s.farms.register({ kind: 'grove', crop: 'oak', bounds })
    if (!entry.ok) throw new Error(entry.error)

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result).toEqual({
      ok: true,
      value: {
        components: [
          {
            id: entry.value.id,
            kind: 'grove',
            harvested: 0,
            replanted: 0,
            planted: 2,
            herdSizeBefore: undefined,
            herdAction: undefined,
            eggsPickedUp: undefined,
            eggsStored: undefined,
            eggsReleased: undefined,
            problem: undefined,
          },
        ],
      },
    })
    expect(s.plantTrees.calls).toEqual([
      expect.objectContaining({
        farm: entry.value.id,
        count: undefined,
        area: undefined,
        preview: false,
      }),
    ])
  })

  it('reports why a grove could not be refilled without failing the rest', async () => {
    const s = await setup(false, true)
    const grove = s.farms.register({ kind: 'grove', crop: 'oak', bounds, group: 'home' })
    const field = s.farms.register({ kind: 'field', crop: 'wheat', bounds, group: 'home' })
    if (!grove.ok || !field.ok) throw new Error('setup failed')
    s.plantTrees.result = err({ reason: 'no_count', message: 'Say how many trees to plant.' })

    const result = await s.skill.run({ farm: 'home' }, context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.components.find((c) => c.kind === 'grove')).toMatchObject({
      planted: 0,
      problem: 'Say how many trees to plant.',
    })
    expect(result.value.components.find((c) => c.kind === 'field')?.harvested).toBe(3)
  })

  it('reports the plots that were lost and replanted, and the ones still bare after the final check', async () => {
    const s = await setup()
    const entry = s.farms.register({ kind: 'field', crop: 'wheat', bounds })
    if (!entry.ok) throw new Error(entry.error)
    s.plant.result = ok({ planted: 5, tilled: 2, skipped: 0, repaired: 2, stillBare: 3 })

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.components[0]).toMatchObject({ planted: 5, repaired: 2, stillBare: 3 })
    expect(result.value.components[0]?.problem).toContain('3 plot(s) are still bare')
  })

  it('says why planting failed instead of showing a bare zero (no hoe, no seeds)', async () => {
    const s = await setup()
    const entry = s.farms.register({ kind: 'field', crop: 'wheat', bounds })
    if (!entry.ok) throw new Error(entry.error)
    s.plant.result = err({ reason: 'no_hoe', message: 'The bot has no hoe to till with.' })

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.components[0]).toMatchObject({
      harvested: 3,
      planted: 0,
      problem: 'The bot has no hoe to till with.',
    })
  })

  it('keeps the harvest problem and adds the planting one', async () => {
    const s = await setup()
    const entry = s.farms.register({ kind: 'field', crop: 'wheat', bounds })
    if (!entry.ok) throw new Error(entry.error)
    s.harvest.result = err({ reason: 'no_area', message: 'nothing to harvest' })
    s.plant.result = err({ reason: 'no_seeds', message: 'no seeds left' })

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.components[0]?.problem).toBe('nothing to harvest no seeds left')
  })

  it('does not plant when the field has no crop set', async () => {
    const s = await setup()
    const entry = s.farms.register({ kind: 'field', bounds })
    if (!entry.ok) throw new Error(entry.error)

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.components[0]).toMatchObject({ planted: 0 })
    expect(s.plant.calls).toEqual([])
  })

  it('carries on when a component reports a failure, and includes the message', async () => {
    const s = await setup()
    const entry = s.farms.register({ kind: 'field', crop: 'wheat', bounds })
    if (!entry.ok) throw new Error(entry.error)
    s.harvest.result = err({ reason: 'no_area', message: 'no area' })

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.components[0]).toMatchObject({
      harvested: 0,
      replanted: 0,
      problem: 'no area',
    })
  })

  it('fails with unknown_farm for an unrecognised id, label, or group', async () => {
    const s = await setup()

    const result = await s.skill.run({ farm: 'nothing-here' }, context())

    expect(result).toMatchObject({ ok: false, error: { reason: 'unknown_farm' } })
  })
})
