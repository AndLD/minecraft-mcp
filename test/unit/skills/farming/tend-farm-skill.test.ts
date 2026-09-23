import { describe, expect, it } from '@jest/globals'
import { err, ok } from '../../../../src/core/result.js'
import type { HarvestCropsSkill } from '../../../../src/skills/farming/harvest-crops-skill.js'
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

async function setup() {
  const farms = new FarmRegistry(new FakeClock(0))
  await farms.attach(new InMemoryStateStore())
  const harvest = new FakeHarvest()
  const plant = new FakePlant()
  const skill = new TendFarmSkill({
    farms,
    harvest: harvest as unknown as HarvestCropsSkill,
    plant: plant as unknown as PlantCropsSkill,
  })
  return { farms, harvest, plant, skill }
}

const bounds = { from: { x: 0, y: 64, z: 0 }, to: { x: 2, y: 64, z: 2 } }

describe('TendFarmSkill', () => {
  it('harvests, replants, and plants any empty plots for one farm', async () => {
    const s = await setup()
    const entry = s.farms.register({ kind: 'field', crop: 'wheat', bounds })
    if (!entry.ok) throw new Error(entry.error)

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result).toEqual({
      ok: true,
      value: {
        components: [
          { id: entry.value.id, kind: 'field', harvested: 3, replanted: 2, planted: 1, problem: undefined },
        ],
      },
    })
    expect(s.harvest.calls).toEqual([{ farm: entry.value.id, area: undefined, replant: true }])
    expect(s.plant.calls).toEqual([
      { farm: entry.value.id, area: undefined, crop: 'wheat', maxPlants: undefined },
    ])
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

  it('reports a non-field component as not yet tended, without failing the rest', async () => {
    const s = await setup()
    const pen = s.farms.register({ kind: 'pen', bounds, group: 'home' })
    const field = s.farms.register({ kind: 'field', crop: 'wheat', bounds, group: 'home' })
    if (!pen.ok || !field.ok) throw new Error('setup failed')

    const result = await s.skill.run({ farm: 'home' }, context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const penResult = result.value.components.find((c) => c.kind === 'pen')
    expect(penResult?.problem).toBe('pen is not tended yet.')
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
