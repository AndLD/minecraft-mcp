import { beforeEach, describe, expect, it } from '@jest/globals'
import { WorldKnowledgeStore } from '../../../../src/knowledge/world-knowledge-store.js'
import { LeadTargetResolver } from '../../../../src/skills/movement/lead-target.js'
import { ContainerIndex } from '../../../../src/state/container-index.js'
import { FarmRegistry } from '../../../../src/state/farm-registry.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { LeadWorld } from '../../../fakes/lead-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const at = (x: number, y: number, z: number) => ({ x, y, z })

describe('LeadTargetResolver', () => {
  let knowledge: WorldKnowledgeStore
  let containers: ContainerIndex
  let farms: FarmRegistry
  let resolver: LeadTargetResolver

  beforeEach(async () => {
    const clock = new FakeClock(0)
    const store = new InMemoryStateStore()
    knowledge = new WorldKnowledgeStore(clock)
    containers = new ContainerIndex(clock)
    farms = new FarmRegistry(clock)
    await knowledge.attach(store)
    await containers.attach(store)
    await farms.attach(store)
    resolver = new LeadTargetResolver({ knowledge, containers, farms, vitals: new LeadWorld() })
  })

  it('finds a landmark by name, in any case', () => {
    knowledge.setLandmark('Home', at(10, 64, 20))

    expect(resolver.resolve('home')).toEqual({
      ok: true,
      value: {
        label: 'Home',
        position: expect.objectContaining({ x: 10, z: 20 }),
        source: 'landmark',
      },
    })
  })

  it('finds the nearest known structure of a kind, ignoring "the"', () => {
    knowledge.record('village', at(500, 64, 0), { source: 'scan' })
    knowledge.record('village', at(120, 64, 30), { source: 'scan' })

    const found = resolver.resolve('the village')

    expect(found).toMatchObject({
      ok: true,
      value: { label: 'the village', source: 'structure', position: { x: 120, z: 30 } },
    })
    expect(resolver.resolve('Desert temple')).toMatchObject({
      ok: false,
      error: expect.stringContaining('explore_for_structure'),
    })
  })

  it('finds a biome that was found', () => {
    knowledge.recordBiome('desert', at(200, 64, -40), { source: 'scan' })

    expect(resolver.resolve('desert')).toMatchObject({
      ok: true,
      value: { label: 'the desert biome', source: 'biome', position: { x: 200 } },
    })
  })

  it('finds a registered chest by label, and a farm by label (the middle of it)', () => {
    containers.register(at(4, 64, 4), 'chest', { label: 'Iron' })
    farms.register({
      kind: 'field',
      bounds: { from: at(10, 63, 10), to: at(20, 63, 16) },
      label: 'Wheat',
    })

    expect(resolver.resolve('iron')).toMatchObject({
      ok: true,
      value: { label: 'Iron', source: 'container', position: { x: 4, z: 4 } },
    })
    expect(resolver.resolve('wheat')).toMatchObject({
      ok: true,
      value: { label: 'Wheat', source: 'farm', position: { x: 15, y: 63, z: 13 } },
    })
  })

  it('prefers a landmark to a structure of the same name', () => {
    knowledge.setLandmark('village', at(1, 64, 1))
    knowledge.record('village', at(300, 64, 0), { source: 'scan' })

    expect(resolver.resolve('village')).toMatchObject({ value: { source: 'landmark' } })
  })

  it('says what is known when nothing matches', () => {
    knowledge.setLandmark('home', at(1, 64, 1))
    containers.register(at(4, 64, 4), 'chest', { label: 'Iron' })

    const missing = resolver.resolve('castle')

    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('home, Iron') })
    expect(
      new LeadTargetResolver({ knowledge, containers, farms, vitals: new LeadWorld() }).resolve(
        '  ',
      ),
    ).toMatchObject({ ok: false })
  })
})
