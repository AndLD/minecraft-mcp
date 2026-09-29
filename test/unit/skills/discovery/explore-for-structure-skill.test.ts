import { beforeEach, describe, expect, it } from '@jest/globals'
import { ok } from '../../../../src/core/result.js'
import { WorldKnowledgeStore } from '../../../../src/knowledge/world-knowledge-store.js'
import {
  ExploreForStructureSkill,
  type ExploreForStructureInput,
} from '../../../../src/skills/discovery/explore-for-structure-skill.js'
import { StructureScanner } from '../../../../src/skills/discovery/structure-scanner.js'
import { defaultSignatures } from '../../../../src/skills/discovery/structure-signatures.js'
import { FakeServerCommands } from '../../../fakes/command-fakes.js'
import { DiscoveryNavigator, DiscoveryWorld, GROUND } from '../../../fakes/discovery-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeRandom } from '../../../fakes/fake-random.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const at = (x: number, y: number, z: number) => ({ x, y, z })

const wanted = (patch: Partial<ExploreForStructureInput> = {}): ExploreForStructureInput => ({
  kind: 'village',
  maxDistance: 300,
  maxMinutes: 10,
  strategy: 'spiral',
  useLocate: true,
  onlyNew: false,
  returnTo: undefined,
  ...patch,
})

/** A village: a bell, a villager, and hay, around one spot. */
const village = (world: DiscoveryWorld, x: number, z: number) =>
  world
    .put(x, GROUND + 1, z, 'bell')
    .mob('villager', x + 2, z)
    .put(x + 3, GROUND + 1, z, 'hay_block')

describe('ExploreForStructureSkill', () => {
  let world: DiscoveryWorld
  let navigator: DiscoveryNavigator
  let knowledge: WorldKnowledgeStore
  let clock: FakeClock
  let commands: FakeServerCommands
  let progress: string[]
  let controller: AbortController
  let skill: ExploreForStructureSkill

  beforeEach(async () => {
    world = new DiscoveryWorld()
    navigator = new DiscoveryNavigator(world)
    clock = new FakeClock(0)
    knowledge = new WorldKnowledgeStore(clock)
    await knowledge.attach(new InMemoryStateStore())
    commands = new FakeServerCommands()
    progress = []
    controller = new AbortController()
    skill = new ExploreForStructureSkill({
      navigator,
      vitals: world,
      blocks: world,
      scanner: new StructureScanner(world, world, defaultSignatures()),
      knowledge,
      clock,
      random: new FakeRandom([0.2, 0.7, 0.4]),
      commands,
    })
  })

  const run = (input: ExploreForStructureInput) =>
    skill.run(input, { signal: controller.signal, progress: (message) => progress.push(message) })

  it('finds a village it can see from where it stands, without walking', async () => {
    village(world, 20, 10)

    const result = await run(wanted())

    expect(result).toMatchObject({
      ok: true,
      value: {
        alreadyKnown: false,
        reached: true,
        found: { kind: 'village', x: 20, z: 10, source: 'scan' },
      },
    })
    expect(navigator.trips).toEqual([])
    expect(knowledge.structures('village')).toHaveLength(1)
  })

  it.each(['spiral', 'frontier'] as const)(
    '%s: walks until a village comes into view, and records it',
    async (strategy) => {
      village(world, 150, 40)

      const result = await run(wanted({ strategy }))

      expect(result).toMatchObject({
        ok: true,
        value: { found: { kind: 'village', x: 150, z: 40 } },
      })
      expect(navigator.trips.length).toBeGreaterThan(0)
      expect(knowledge.structures('village')).toHaveLength(1)
    },
  )

  it('reports the distance from where it started, and the hops it took', async () => {
    village(world, 150, 0)

    const result = await run(wanted())

    expect(result).toMatchObject({ ok: true, value: { distanceFromStart: 150 } })
    expect(result.ok && result.value.hops).toBeGreaterThan(0)
    expect(progress.some((line) => line.startsWith('Found a village'))).toBe(true)
  })

  it('records other structures on the way and lists them as discovered', async () => {
    world.put(60, 45, 0, 'end_portal_frame')
    village(world, 200, 0)

    const result = await run(wanted())

    expect(result.ok && result.value.discovered.map((entry) => entry.kind)).toEqual(['stronghold'])
    expect(
      knowledge
        .structures()
        .map((entry) => entry.kind)
        .sort(),
    ).toEqual(['stronghold', 'village'])
  })

  it('answers with a known structure at once, and explores nothing', async () => {
    knowledge.record('village', at(120, 64, 30), { source: 'scan' })

    const result = await run(wanted())

    expect(result).toMatchObject({ ok: true, value: { alreadyKnown: true, found: { x: 120 } } })
    expect(navigator.trips).toEqual([])
  })

  it('does not use a known structure beyond max_distance', async () => {
    knowledge.record('village', at(2000, 64, 0), { source: 'scan' })
    village(world, 100, 0)

    const result = await run(wanted({ maxDistance: 300 }))

    expect(result).toMatchObject({ ok: true, value: { alreadyKnown: false, found: { x: 100 } } })
    expect(knowledge.structures('village')).toHaveLength(2)
  })

  it('looks for a new one when only_new is set, and ignores the one in view that is known', async () => {
    village(world, 20, 0)
    knowledge.record('village', at(20, 65, 0), { source: 'scan' })
    village(world, 200, 100)

    const result = await run(wanted({ onlyNew: true }))

    expect(result).toMatchObject({
      ok: true,
      value: { alreadyKnown: false, found: { x: 200, z: 100 } },
    })
  })

  it('fails with not_found when the area holds none, saying how far it looked', async () => {
    const result = await run(wanted({ maxDistance: 100 }))

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'not_found', detail: { stopped: 'exhausted', farthest: 89 } },
    })
    expect(result.ok ? 0 : (result.error.detail as { hops: number }).hops).toBeGreaterThan(5)
  })

  it('stays within max_distance of the start, whatever the strategy', async () => {
    await run(wanted({ maxDistance: 120, strategy: 'frontier' }))

    for (const trip of navigator.trips)
      expect(Math.hypot(trip.x, trip.z)).toBeLessThanOrEqual(120 + 3)
  })

  it('stops when the time is up', async () => {
    navigator.afterTrip = () => {
      clock.advance(4 * 60_000)
    }

    const result = await run(wanted({ maxMinutes: 10 }))

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'not_found', detail: { stopped: 'time' } },
    })
    expect(navigator.trips).toHaveLength(3)
  })

  it('goes round a lake: the column is water, so it is not walked to', async () => {
    world.lake(35, -5, 45, 5)

    await run(wanted({ maxDistance: 45 }))

    expect(navigator.trips.some((trip) => trip.x === 40 && trip.z === 0)).toBe(false)
  })

  it('carries on after a trip that fails, and gives up after five in a row', async () => {
    navigator.refuse = () => ({ reason: 'unreachable', message: 'No path.' })

    const result = await run(wanted())

    expect(result).toMatchObject({ ok: false, error: { reason: 'stuck', detail: { hops: 0 } } })
    expect(navigator.trips).toHaveLength(5)
  })

  it('does not count failures that were not in a row', async () => {
    let count = 0
    navigator.refuse = () => {
      count += 1
      return count % 3 === 0 ? { reason: 'unreachable', message: 'No path.' } : undefined
    }

    const result = await run(wanted({ maxDistance: 100 }))

    expect(result).toMatchObject({ ok: false, error: { reason: 'not_found' } })
  })

  it('stops at once when cancelled', async () => {
    navigator.afterTrip = () => {
      controller.abort()
    }

    const result = await run(wanted())

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(navigator.trips).toHaveLength(1)
  })

  it('stops when a trip reports it was cancelled', async () => {
    navigator.refuse = () => ({ reason: 'aborted', message: 'Cancelled.' })

    expect(await run(wanted())).toMatchObject({ ok: false, error: { reason: 'aborted' } })
  })

  it('refuses in the Nether and the End, without a world, and without a bot', async () => {
    world.dimension = 'minecraft:the_nether'
    expect(await run(wanted())).toMatchObject({ ok: false, error: { reason: 'wrong_dimension' } })

    world.dimension = 'minecraft:overworld'
    knowledge.detach()
    expect(await run(wanted())).toMatchObject({ ok: false, error: { reason: 'no_world_profile' } })

    const absent = new ExploreForStructureSkill({
      navigator,
      vitals: { read: () => undefined },
      blocks: world,
      scanner: new StructureScanner(world, world, defaultSignatures()),
      knowledge,
      clock,
      random: new FakeRandom(),
    })
    expect(
      await absent.run(wanted(), { signal: controller.signal, progress: () => undefined }),
    ).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
  })

  describe('returning to a landmark', () => {
    it('walks back after a find', async () => {
      knowledge.setLandmark('home', at(5, 64, 5))
      village(world, 100, 0)

      const result = await run(wanted({ returnTo: 'Home' }))

      expect(result).toMatchObject({ ok: true, value: { returned: true } })
      expect(navigator.trips.at(-1)).toEqual(at(5, 64, 5))
    })

    it('walks back after a failed search too', async () => {
      knowledge.setLandmark('home', at(5, 64, 5))

      const result = await run(wanted({ maxDistance: 60, returnTo: 'home' }))

      expect(result).toMatchObject({ ok: false, error: { detail: { returned: true } } })
      expect(navigator.trips.at(-1)).toEqual(at(5, 64, 5))
    })

    it('says when it could not get back', async () => {
      knowledge.setLandmark('home', at(5, 64, 5))
      village(world, 100, 0)
      navigator.refuse = (target) =>
        target.x === 5 ? { reason: 'unreachable', message: 'No path.' } : undefined

      expect(await run(wanted({ returnTo: 'home' }))).toMatchObject({
        ok: true,
        value: { returned: false },
      })
    })

    it('fails before starting when the landmark is unknown', async () => {
      expect(await run(wanted({ returnTo: 'nowhere' }))).toMatchObject({
        ok: false,
        error: { reason: 'unknown_landmark' },
      })
      expect(navigator.trips).toEqual([])
    })
  })

  describe('asking the server with /locate', () => {
    beforeEach(() => {
      commands.offered = ['locate', 'tp']
    })

    const located = (x: number, z: number) =>
      ok({
        kind: 'ok' as const,
        reply: `The nearest minecraft:village_plains is at [${String(x)}, ~, ${String(z)}] (${String(Math.round(Math.hypot(x, z)))} blocks away)`,
      })

    it('walks to the place the server names, and takes the exact spot from the blocks', async () => {
      commands.outcomes = [located(180, 60)]
      village(world, 190, 55)

      const result = await run(wanted())

      expect(commands.sent).toEqual(['locate structure #minecraft:village'])
      expect(result).toMatchObject({
        ok: true,
        value: { reached: true, found: { source: 'scan', x: 190, z: 55 } },
      })
      expect(knowledge.structures('village')).toHaveLength(1)
    })

    it('reports a place the server named when there is nothing to see there', async () => {
      commands.outcomes = [located(180, 60)]

      const result = await run(wanted())

      expect(result).toMatchObject({
        ok: true,
        value: { reached: true, found: { source: 'locate', x: 180, z: 60 } },
      })
    })

    it('only records a place beyond max_distance, and does not go', async () => {
      commands.outcomes = [located(2000, 0)]

      const result = await run(wanted({ maxDistance: 300 }))

      expect(result).toMatchObject({
        ok: true,
        value: { reached: false, found: { source: 'locate', x: 2000 } },
      })
      expect(navigator.trips).toEqual([])
    })

    it('says it could not reach a named place when the way is blocked', async () => {
      commands.outcomes = [located(180, 60)]
      navigator.refuse = () => ({ reason: 'unreachable', message: 'No path.' })

      const result = await run(wanted())

      expect(result).toMatchObject({
        ok: true,
        value: { reached: false, found: { source: 'locate' } },
      })
    })

    it('searches on foot when the server refuses, has no reply, or the option is off', async () => {
      for (const outcome of [
        ok({ kind: 'no_permission' as const, reply: 'Unknown or incomplete command' }),
        ok({ kind: 'ok' as const, reply: 'Could not find that structure nearby' }),
        ok({ kind: 'sent' as const }),
      ]) {
        commands.outcomes = [outcome]
        expect(await run(wanted({ maxDistance: 60 }))).toMatchObject({
          ok: false,
          error: { reason: 'not_found' },
        })
      }
      commands.sent.length = 0
      await run(wanted({ maxDistance: 60, useLocate: false }))
      expect(commands.sent).toEqual([])
    })

    it('does not ask for a dungeon (the server cannot locate one), or with only_new, or when not allowed', async () => {
      await run(wanted({ kind: 'dungeon', maxDistance: 60 }))
      await run(wanted({ onlyNew: true, maxDistance: 60 }))
      commands.offered = ['tp']
      await run(wanted({ maxDistance: 60 }))
      commands.offered = undefined
      await run(wanted({ maxDistance: 60 }))

      expect(commands.sent).toEqual([])
    })

    it('stops when cancelled during the walk', async () => {
      commands.outcomes = [located(180, 60)]
      navigator.afterTrip = () => {
        controller.abort()
      }

      expect(await run(wanted())).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    })
  })
})
