import { describe, expect, it } from '@jest/globals'
import { WorldKnowledgeStore } from '../../../src/knowledge/world-knowledge-store.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { InMemoryStateStore } from '../../fakes/state-fakes.js'

const at = (x: number, y: number, z: number) => ({ x, y, z })

async function active() {
  const knowledge = new WorldKnowledgeStore(new FakeClock(0))
  const store = new InMemoryStateStore()
  await knowledge.attach(store)
  return { knowledge, store }
}

describe('WorldKnowledgeStore: landmarks', () => {
  it('names a place, finds it in any case, and replaces one of the same name', async () => {
    const { knowledge } = await active()

    knowledge.setLandmark('Home', at(10.4, 64, -3.6), 'the first house')
    knowledge.setLandmark('home', at(20, 70, 5))

    expect(knowledge.landmarks()).toHaveLength(1)
    expect(knowledge.landmark('HOME')).toMatchObject({ name: 'home', x: 20, y: 70, z: 5 })
    expect(knowledge.landmark('HOME')?.note).toBeUndefined()
  })

  it('rounds coordinates and keeps the note', async () => {
    const { knowledge } = await active()

    const set = knowledge.setLandmark('mine', at(1.6, 12.2, -0.4), 'iron here')

    expect(set).toMatchObject({ ok: true, value: { x: 2, y: 12, z: -0, note: 'iron here' } })
  })

  it('removes a landmark, and says when there was none', async () => {
    const { knowledge } = await active()
    knowledge.setLandmark('home', at(0, 64, 0))

    expect(knowledge.removeLandmark('Home')).toBe(true)
    expect(knowledge.removeLandmark('home')).toBe(false)
    expect(knowledge.landmarks()).toEqual([])
  })

  it('refuses to save while no world is active', () => {
    const knowledge = new WorldKnowledgeStore(new FakeClock(0))

    expect(knowledge.setLandmark('home', at(0, 0, 0))).toMatchObject({ ok: false })
    expect(knowledge.record('village', at(0, 0, 0), { source: 'scan' })).toMatchObject({
      ok: false,
    })
    expect(knowledge.removeLandmark('home')).toBe(false)
    expect(knowledge.active).toBe(false)
  })
})

describe('WorldKnowledgeStore: structures', () => {
  it('records a find once, and recognizes another sighting of the same structure', async () => {
    const { knowledge } = await active()

    const first = knowledge.record('village', at(100, 64, 100), {
      source: 'scan',
      detail: 'a bell',
    })
    const again = knowledge.record('village', at(140, 66, 120), { source: 'scan' })
    const other = knowledge.record('village', at(400, 64, 100), { source: 'scan' })

    expect(first).toMatchObject({ ok: true, value: { isNew: true } })
    expect(again).toMatchObject({ ok: true, value: { isNew: false, entry: { x: 100, z: 100 } } })
    expect(other).toMatchObject({ ok: true, value: { isNew: true } })
    expect(knowledge.structures('village')).toHaveLength(2)
  })

  it('keeps different kinds apart even at the same place', async () => {
    const { knowledge } = await active()

    knowledge.record('village', at(0, 64, 0), { source: 'scan' })
    const dungeon = knowledge.record('dungeon', at(0, 30, 0), { source: 'scan' })

    expect(dungeon).toMatchObject({ ok: true, value: { isNew: true } })
    expect(knowledge.structures()).toHaveLength(2)
    expect(knowledge.structures('dungeon')).toHaveLength(1)
  })

  it('replaces a place the server named with the exact spot once the bot sees it', async () => {
    const { knowledge } = await active()
    knowledge.record('village', at(200, 64, 200), { source: 'locate' })

    const seen = knowledge.record('village', at(215, 66, 190), { source: 'scan', detail: 'a bell' })

    expect(seen).toMatchObject({
      ok: true,
      value: { isNew: false, entry: { x: 215, y: 66, z: 190, source: 'scan', detail: 'a bell' } },
    })
    expect(knowledge.structures()).toHaveLength(1)
  })

  it('does not downgrade a sighting to a located place', async () => {
    const { knowledge } = await active()
    knowledge.record('village', at(200, 64, 200), { source: 'scan' })

    const named = knowledge.record('village', at(210, 64, 210), { source: 'locate' })

    expect(named).toMatchObject({ ok: true, value: { entry: { source: 'scan', x: 200 } } })
  })

  it('finds the nearest structure of a kind', async () => {
    const { knowledge } = await active()
    knowledge.record('village', at(500, 64, 0), { source: 'scan' })
    knowledge.record('village', at(-200, 64, 0), { source: 'scan' })

    expect(knowledge.nearest('village', at(0, 64, 0))).toMatchObject({ x: -200 })
    expect(knowledge.nearest('mineshaft', at(0, 64, 0))).toBeUndefined()
  })
})

describe('WorldKnowledgeStore: persistence', () => {
  it('lists the same landmarks and structures in a new instance on the same store', async () => {
    const { knowledge, store } = await active()
    knowledge.setLandmark('home', at(1, 64, 2), 'base')
    knowledge.record('desert_temple', at(300, 70, -80), { source: 'scan', detail: 'tnt' })

    const later = new WorldKnowledgeStore(new FakeClock(5))
    await later.attach(store)

    expect(later.landmark('home')).toMatchObject({ x: 1, y: 64, z: 2, note: 'base' })
    expect(later.structures()).toMatchObject([{ kind: 'desert_temple', x: 300, y: 70, z: -80 }])
    expect(later.record('jungle_temple', at(0, 0, 0), { source: 'scan' })).toMatchObject({
      ok: true,
      value: { entry: { id: 'structure-2' } },
    })
  })

  it('starts empty on a corrupt file and passes the warning on', async () => {
    const knowledge = new WorldKnowledgeStore(new FakeClock(0))
    const store = new InMemoryStateStore()
    store.warnOnLoad = 'knowledge.json was corrupt'

    expect(await knowledge.attach(store)).toEqual(['knowledge.json was corrupt'])
    expect(knowledge.structures()).toEqual([])
  })

  it('forgets everything on detach', async () => {
    const { knowledge } = await active()
    knowledge.setLandmark('home', at(0, 0, 0))

    knowledge.detach()

    expect(knowledge.landmarks()).toEqual([])
    expect(knowledge.active).toBe(false)
  })
})
