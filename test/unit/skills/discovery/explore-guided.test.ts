import { beforeEach, describe, expect, it } from '@jest/globals'
import {
  DEFAULT_BIOME_TABLE_VERSION,
  STRUCTURE_BIOME_TABLES,
} from '../../../../src/knowledge/structure-biomes/index.js'
import { StructureBiomeTables } from '../../../../src/knowledge/structure-biomes/structure-biome-tables.js'
import { WorldKnowledgeStore } from '../../../../src/knowledge/world-knowledge-store.js'
import {
  ExploreForStructureSkill,
  type ExploreForStructureInput,
} from '../../../../src/skills/discovery/explore-for-structure-skill.js'
import { StructureScanner } from '../../../../src/skills/discovery/structure-scanner.js'
import { defaultSignatures } from '../../../../src/skills/discovery/structure-signatures.js'
import { DiscoveryNavigator, DiscoveryWorld, GROUND } from '../../../fakes/discovery-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeRandom } from '../../../fakes/fake-random.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const wanted = (patch: Partial<ExploreForStructureInput> = {}): ExploreForStructureInput => ({
  kind: 'desert_temple',
  maxDistance: 500,
  maxMinutes: 30,
  strategy: 'guided',
  useLocate: false,
  onlyNew: false,
  returnTo: undefined,
  ...patch,
})

/** Sea to the west, a desert with a temple in the east, plains between. */
function shoreWorld(): DiscoveryWorld {
  const world = new DiscoveryWorld()
  world.biomeNames = [...world.biomeNames, 'ocean', 'savanna', 'beach']
  world.biome('desert', 110, -80, 260, 80).biome('ocean', -2000, -2000, -30, 2000)
  world.put(170, GROUND + 1, 10, 'chiseled_sandstone').put(171, GROUND + 1, 10, 'tnt')
  return world
}

describe('ExploreForStructureSkill, guided by biome', () => {
  let clock: FakeClock

  beforeEach(() => {
    clock = new FakeClock(0)
  })

  async function search(
    world: DiscoveryWorld,
    input: ExploreForStructureInput,
    options: { tables?: boolean; version?: string } = {},
  ) {
    const knowledge = new WorldKnowledgeStore(clock)
    await knowledge.attach(new InMemoryStateStore())
    const skill = new ExploreForStructureSkill({
      navigator: new DiscoveryNavigator(world),
      vitals: world,
      blocks: world,
      biomes: world,
      entities: world,
      scanner: new StructureScanner(world, world, defaultSignatures()),
      knowledge,
      clock,
      random: new FakeRandom([0.2, 0.7, 0.4]),
      ...(options.tables === false
        ? {}
        : {
            biomeTables: new StructureBiomeTables({
              tables: STRUCTURE_BIOME_TABLES,
              defaultVersion: DEFAULT_BIOME_TABLE_VERSION,
              version: options.version ?? '1.21.1',
              biomes: world,
              logger: new FakeLogger(),
            }),
          }),
    })
    return skill.run(input, { signal: new AbortController().signal, progress: () => undefined })
  }

  it('finds the temple in fewer hops than the frontier search, and says how it searched', async () => {
    const guided = await search(shoreWorld(), wanted())
    const frontier = await search(shoreWorld(), wanted({ strategy: 'frontier' }))

    expect(guided).toMatchObject({
      ok: true,
      value: { found: { kind: 'desert_temple' }, searched: 'guided' },
    })
    expect(frontier).toMatchObject({ ok: true, value: { searched: 'frontier' } })
    if (!guided.ok || !frontier.ok) return
    expect(guided.value.hops).toBeLessThan(frontier.value.hops)
  })

  it('uses the default table on a version that has none, and still guides', async () => {
    const result = await search(shoreWorld(), wanted(), { version: '1.20.4' })

    expect(result).toMatchObject({ ok: true, value: { searched: 'guided' } })
  })

  it('searches a kind with no biome rule as a frontier search', async () => {
    const world = shoreWorld()
    world.put(60, GROUND + 1, 0, 'end_portal_frame')

    const result = await search(world, wanted({ kind: 'stronghold' }))

    expect(result).toMatchObject({ ok: true, value: { searched: 'frontier' } })
  })

  it('searches as a frontier search when there are no tables at all', async () => {
    const result = await search(shoreWorld(), wanted(), { tables: false })

    expect(result).toMatchObject({ ok: true, value: { searched: 'frontier' } })
  })

  it('a biome or mob search is a frontier search whatever the option says', async () => {
    const biome = await search(shoreWorld(), wanted({ kind: undefined, biome: 'desert' }))
    const mob = await search(
      shoreWorld().mob('fox', 70, 0),
      wanted({ kind: undefined, mob: 'fox' }),
    )

    expect(biome).toMatchObject({ ok: true, value: { searched: 'frontier' } })
    expect(mob).toMatchObject({ ok: true, value: { found: { kind: 'mob' } } })
  })

  it('keeps the spiral when asked for it', async () => {
    const result = await search(shoreWorld(), wanted({ strategy: 'spiral' }))

    expect(result).toMatchObject({ ok: true, value: { searched: 'spiral' } })
  })

  it('says how far it looked, and how, when nothing is found', async () => {
    const world = shoreWorld()
    world.put(170, GROUND + 1, 10, 'air').put(171, GROUND + 1, 10, 'air')

    const result = await search(world, wanted({ maxDistance: 100, maxMinutes: 5 }))

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'not_found', detail: { searched: 'guided' } },
    })
  })
})
