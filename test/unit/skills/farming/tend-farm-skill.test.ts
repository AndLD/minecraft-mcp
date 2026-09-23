import { describe, expect, it } from '@jest/globals'
import { err, ok } from '../../../../src/core/result.js'
import type { HarvestCropsSkill } from '../../../../src/skills/farming/harvest-crops-skill.js'
import type { HerdManager } from '../../../../src/skills/farming/herd-manager.js'
import type { PlantCropsSkill } from '../../../../src/skills/farming/plant-crops-skill.js'
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
  result: Awaited<ReturnType<PlantCropsSkill['run']>> = ok({ planted: 1, tilled: 0, skipped: 0 })
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

async function setup() {
  const farms = new FarmRegistry(new FakeClock(0))
  await farms.attach(new InMemoryStateStore())
  const harvest = new FakeHarvest()
  const plant = new FakePlant()
  const herd = new FakeHerd()
  const skill = new TendFarmSkill({
    farms,
    harvest: harvest as unknown as HarvestCropsSkill,
    plant: plant as unknown as PlantCropsSkill,
    herd: herd as unknown as HerdManager,
  })
  return { farms, harvest, plant, herd, skill }
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
            herdSizeBefore: undefined,
            herdAction: undefined,
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
            problem: undefined,
          },
        ],
      },
    })
    expect(s.herd.calls).toEqual([{ species: 'cow', targetSize: 6, bounds }])
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
    expect(result.value.components[0]).toMatchObject({ harvested: 0, replanted: 0, problem: 'no area' })
  })

  it('fails with unknown_farm for an unrecognised id, label, or group', async () => {
    const s = await setup()

    const result = await s.skill.run({ farm: 'nothing-here' }, context())

    expect(result).toMatchObject({ ok: false, error: { reason: 'unknown_farm' } })
  })
})
