import { describe, expect, it } from '@jest/globals'
import { WorldKnowledgeStore } from '../../src/knowledge/world-knowledge-store.js'
import { ExploreForStructureSkill } from '../../src/skills/discovery/explore-for-structure-skill.js'
import { StructureScanner } from '../../src/skills/discovery/structure-scanner.js'
import { defaultSignatures } from '../../src/skills/discovery/structure-signatures.js'
import { DiscoveryNavigator, DiscoveryWorld, GROUND } from '../fakes/discovery-fakes.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { FakeRandom } from '../fakes/fake-random.js'
import { InMemoryStateStore } from '../fakes/state-fakes.js'

/** Explore, find, persist: a new run of the app on the same world state still lists the structure. */
describe('exploring for a structure, and remembering it', () => {
  it('finds a village, saves it, and lists it again after a restart', async () => {
    const files = new InMemoryStateStore()
    const clock = new FakeClock(Date.parse('2026-05-01T10:00:00Z'))
    const world = new DiscoveryWorld()
    world
      .put(120, GROUND + 1, 60, 'bell')
      .mob('villager', 122, 60)
      .put(123, GROUND + 1, 60, 'hay_block')
    const before = new WorldKnowledgeStore(clock)
    await before.attach(files)
    const skill = new ExploreForStructureSkill({
      navigator: new DiscoveryNavigator(world),
      vitals: world,
      blocks: world,
      biomes: world,
      entities: world,
      scanner: new StructureScanner(world, world, defaultSignatures()),
      knowledge: before,
      clock,
      random: new FakeRandom(),
    })

    const found = await skill.run(
      {
        kind: 'village',
        maxDistance: 400,
        maxMinutes: 10,
        strategy: 'frontier',
        useLocate: true,
        onlyNew: false,
        returnTo: undefined,
      },
      { signal: new AbortController().signal, progress: () => undefined },
    )
    before.detach()

    const after = new WorldKnowledgeStore(clock)
    await after.attach(files)
    expect(found).toMatchObject({ ok: true, value: { found: { x: 120, z: 60 } } })
    expect(after.structures()).toMatchObject([
      {
        kind: 'village',
        x: 120,
        y: GROUND + 1,
        z: 60,
        source: 'scan',
        foundAt: '2026-05-01T10:00:00.000Z',
      },
    ])

    // A second request answers from the saved record without walking anywhere.
    const trips = new DiscoveryNavigator(world)
    const again = await new ExploreForStructureSkill({
      navigator: trips,
      vitals: world,
      blocks: world,
      biomes: world,
      entities: world,
      scanner: new StructureScanner(world, world, defaultSignatures()),
      knowledge: after,
      clock,
      random: new FakeRandom(),
    }).run(
      {
        kind: 'village',
        maxDistance: 400,
        maxMinutes: 10,
        strategy: 'spiral',
        useLocate: true,
        onlyNew: false,
        returnTo: undefined,
      },
      { signal: new AbortController().signal, progress: () => undefined },
    )
    expect(again).toMatchObject({ ok: true, value: { alreadyKnown: true } })
    expect(trips.trips).toEqual([])
  })
})
