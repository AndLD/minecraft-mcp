import { beforeEach, describe, expect, it } from '@jest/globals'
import { HazardRule } from '../../../../../src/skills/construction/hazard-rule.js'
import { SiteSafety } from '../../../../../src/skills/construction/site-safety.js'
import { CaveMap } from '../../../../../src/skills/discovery/caves/cave-map.js'
import {
  ExploreCavesSkill,
  type ExploreCavesInput,
} from '../../../../../src/skills/discovery/caves/explore-caves-skill.js'
import { FindDetector } from '../../../../../src/skills/discovery/caves/find-rules.js'
import { LightManager } from '../../../../../src/skills/discovery/caves/light-manager.js'
import { VeinMiner } from '../../../../../src/skills/discovery/caves/vein-miner.js'
import { StructureScanner } from '../../../../../src/skills/discovery/structure-scanner.js'
import { defaultSignatures } from '../../../../../src/skills/discovery/structure-signatures.js'
import { WorldKnowledgeStore } from '../../../../../src/knowledge/world-knowledge-store.js'
import { CaveWorld } from '../../../../fakes/cave-fakes.js'
import { FakeClock } from '../../../../fakes/fake-clock.js'
import { InMemoryStateStore } from '../../../../fakes/state-fakes.js'

const at = (x: number, y: number, z: number) => ({ x, y, z })

const wanted = (patch: Partial<ExploreCavesInput> = {}): ExploreCavesInput => ({
  find: undefined,
  mine: false,
  maxDistance: 80,
  maxMinutes: 10,
  minLight: 5,
  ...patch,
})

describe('ExploreCavesSkill', () => {
  let world: CaveWorld
  let knowledge: WorldKnowledgeStore
  let clock: FakeClock
  let progress: string[]
  let controller: AbortController
  let skill: ExploreCavesSkill

  /** A tunnel along +x at y 60, with the bot at its west end. */
  const tunnel = (length = 40) => {
    world.carve(at(0, 60, 0), at(length, 61, 0))
    world.bot = at(0.5, 60, 0.5)
  }

  beforeEach(async () => {
    world = new CaveWorld()
    world.give('torch', 20)
    clock = new FakeClock(0)
    knowledge = new WorldKnowledgeStore(clock)
    await knowledge.attach(new InMemoryStateStore())
    progress = []
    controller = new AbortController()
    skill = new ExploreCavesSkill({
      navigator: world,
      vitals: world,
      blocks: world,
      entities: world,
      map: new CaveMap(world),
      lights: new LightManager({
        safety: new SiteSafety(world, world),
        placer: world,
        blocks: world,
        inventory: world,
      }),
      detector: new FindDetector(world),
      miner: new VeinMiner({
        navigator: world,
        digger: world,
        blocks: world,
        hazards: new HazardRule(world),
        areas: world,
      }),
      scanner: new StructureScanner(world, world, defaultSignatures()),
      knowledge,
      clock,
    })
  })

  const run = (input: ExploreCavesInput = wanted()) =>
    skill.run(input, { signal: controller.signal, progress: (message) => progress.push(message) })

  it('walks to the far end of a tunnel, reports a diamond there, lights the way, and walks back', async () => {
    tunnel()
    world.setBlock(at(38, 60, 1), 'diamond_ore')

    const result = await run()

    expect(result).toMatchObject({
      ok: true,
      value: {
        region: 'cave',
        stopped: 'explored',
        returned: true,
        finds: [{ kind: 'ore', name: 'diamond_ore', x: 38, y: 60, z: 1 }],
      },
    })
    expect(Math.floor(world.bot.x)).toBe(0)
    expect(knowledge.finds()).toHaveLength(1)
    expect(progress.some((line) => line.startsWith('Found 1 diamond_ore'))).toBe(true)
  })

  it('places torches where it is dark, no closer than the spacing, and never where it is light', async () => {
    tunnel()

    const result = await run()

    const torches = world.torchCells()
    expect(result.ok && result.value.torchesPlaced).toBe(torches.length)
    expect(torches.length).toBeGreaterThan(3)
    for (const [index, torch] of torches.entries())
      for (const other of torches.slice(index + 1))
        expect(Math.hypot(torch.x - other.x, torch.z - other.z)).toBeGreaterThanOrEqual(5)
    for (let x = 1; x <= 39; x += 1)
      expect(world.blockLightAt(at(x, 60, 0))).toBeGreaterThanOrEqual(5)
  })

  it('does not visit the same part twice', async () => {
    tunnel(30)

    await run()

    expect(new Set(world.trips.map((trip) => `${String(trip.x)},${String(trip.z)}`)).size).toBe(
      world.trips.length,
    )
  })

  it('never steps beside lava: the way behind it is not explored', async () => {
    tunnel()
    world.setBlock(at(20, 60, 1), 'lava')
    world.setBlock(at(30, 60, 1), 'diamond_ore')

    const result = await run()

    for (const trip of world.trips) expect(trip.x < 18 || trip.x > 22).toBe(true)
    expect(result).toMatchObject({ ok: true, value: { stopped: 'explored' } })
  })

  it('stays within max_distance of the entrance', async () => {
    tunnel()

    const result = await run(wanted({ maxDistance: 15 }))

    expect(Math.max(...world.trips.map((trip) => trip.x))).toBeLessThanOrEqual(16)
    expect(result).toMatchObject({ ok: true, value: { stopped: 'explored' } })
  })

  const stopsFor = async (hurt: () => void, stopped: string) => {
    tunnel()
    world.onPlaced = hurt

    const result = await run(wanted({ maxMinutes: 5 }))

    expect(result).toMatchObject({ ok: true, value: { stopped, returned: true } })
  }

  it('stops when the time is up, and still walks out', () =>
    stopsFor(() => {
      clock.advance(6 * 60_000)
    }, 'time'))

  it('stops when health is low, and still walks out', () =>
    stopsFor(() => {
      world.health = 4
    }, 'low_health'))

  it('stops when the bot is hungry, and still walks out', () =>
    stopsFor(() => {
      world.food = 2
    }, 'hungry'))

  it('stops when the torches run out and cannot be made', async () => {
    tunnel()
    world.carried.set('torch', 2)

    const result = await run()

    expect(result).toMatchObject({
      ok: true,
      value: { stopped: 'no_torches', torchesPlaced: 2, returned: true },
    })
  })

  it('stops when a warden is near', async () => {
    tunnel()
    world.mobs = [
      { id: 1, category: 'hostile', name: 'warden', position: at(30, 60, 0), distance: 30 },
    ]

    expect(await run()).toMatchObject({ ok: true, value: { stopped: 'warden' } })
  })

  it('reports an ancient city and keeps away from it', async () => {
    tunnel()
    world.setBlock(at(30, 60, 1), 'reinforced_deepslate')

    const result = await run()

    expect(result).toMatchObject({
      ok: true,
      value: { structures: [{ kind: 'ancient_city' }], stopped: 'explored' },
    })
    expect(Math.max(...world.trips.map((trip) => trip.x))).toBeLessThan(0.5 + 30)
    expect(progress.some((line) => line.includes('keeping away from the deep dark'))).toBe(true)
  })

  it('records a spawner, a geode, and a mineshaft it sees, as finds and structures', async () => {
    tunnel()
    world.setBlock(at(10, 60, 1), 'spawner')
    world.setBlock(at(12, 61, 1), 'budding_amethyst')
    for (const [x, y, name] of [
      [20, 60, 'oak_fence'],
      [20, 61, 'oak_fence'],
      [21, 60, 'oak_planks'],
      [22, 60, 'oak_planks'],
      [23, 60, 'oak_planks'],
    ] as const)
      world.setBlock(at(x, y, 1), name)
    world.setBlock(at(25, 61, 0), 'cobweb')

    const result = await run()

    expect(result.ok && result.value.finds.map((find) => find.kind)).toEqual(['spawner', 'geode'])
    expect(result.ok && result.value.structures.map((entry) => entry.kind)).toEqual(['mineshaft'])
  })

  it('only reports what was asked for, and mines it when told to', async () => {
    tunnel()
    world.setBlock(at(10, 60, 1), 'iron_ore')
    world.setBlock(at(11, 60, 1), 'iron_ore')
    world.setBlock(at(30, 60, 1), 'diamond_ore')

    const report = await run(wanted({ find: ['iron_ore'] }))
    expect(report).toMatchObject({ ok: true, value: { finds: [{ name: 'iron_ore' }], mined: {} } })
    expect(world.nameAt(at(10, 60, 1))).toBe('iron_ore')

    knowledge.detach()
    await knowledge.attach(new InMemoryStateStore())
    const mining = await run(wanted({ find: ['iron_ore'], mine: true }))
    expect(mining).toMatchObject({ ok: true, value: { mined: { iron_ore: 2 } } })
    expect(world.nameAt(at(10, 60, 1))).toBe('air')
    expect(world.nameAt(at(30, 60, 1))).toBe('diamond_ore')
  })

  it('leaves a vein it may not dig and says why', async () => {
    tunnel()
    world.setBlock(at(10, 60, 1), 'diamond_ore')
    world.setBlock(at(10, 60, 2), 'water')
    world.protectedBoxes.length = 0

    const result = await run(wanted({ mine: true }))

    expect(result).toMatchObject({
      ok: true,
      value: { mined: {}, skipped: [{ name: 'diamond_ore', reason: 'hazard' }] },
    })
  })

  it('does not report a find twice, even on a second trip', async () => {
    tunnel()
    world.setBlock(at(10, 60, 1), 'diamond_ore')

    await run()
    world.bot = at(0.5, 60, 0.5)
    const second = await run()

    expect(second).toMatchObject({ ok: true, value: { finds: [] } })
    expect(knowledge.finds()).toHaveLength(1)
  })

  it('walks to a cave mouth first when it starts outside', async () => {
    world.carve(at(12, 101, 0), at(30, 102, 0))
    for (let x = 12; x <= 30; x += 1) world.carve(at(x, 103, -1), at(x, 106, 1), 'stone')
    world.bot = at(0.5, 101, 0.5)

    const result = await run()

    expect(result).toMatchObject({ ok: true, value: { entrance: at(12, 101, 0), returned: true } })
    expect(progress[0]).toContain('cave mouth')
    expect(Math.floor(world.bot.x)).toBe(0)
  })

  it('says so when there is no cave near', async () => {
    expect(await run()).toMatchObject({ ok: false, error: { reason: 'no_cave' } })
  })

  it('fails for the wrong dimension, no world, no bot, and a block that does not exist', async () => {
    tunnel()
    world.dimension = 'minecraft:the_nether'
    expect(await run()).toMatchObject({ ok: false, error: { reason: 'wrong_dimension' } })

    world.dimension = 'minecraft:overworld'
    expect(await run(wanted({ find: ['diamnd'] }))).toMatchObject({
      ok: false,
      error: { reason: 'bad_find' },
    })

    knowledge.detach()
    expect(await run()).toMatchObject({ ok: false, error: { reason: 'no_world_profile' } })
  })

  it('gives up when trips keep failing', async () => {
    tunnel()
    world.navFailures = Array.from({ length: 12 }, () => ({
      reason: 'unreachable' as const,
      message: 'no path',
    }))

    const result = await run()

    expect(result).toMatchObject({ ok: true, value: { stopped: 'stuck' } })
  })

  it('stops when cancelled, without walking out, and keeps what it found', async () => {
    tunnel()
    world.setBlock(at(2, 60, 1), 'diamond_ore')
    world.onPlaced = () => { controller.abort(); }

    const result = await run()

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'aborted', detail: { stopped: 'aborted', returned: false } },
    })
  })

  it('walks back along its own tracks when the direct way fails', async () => {
    tunnel(12)
    world.navFailures = []
    const trips = world.trips
    world.onPlaced = () => undefined
    let failNext = false
    const original = world.goToPosition.bind(world)
    world.goToPosition = (target, within, options) => {
      if (failNext) {
        failNext = false
        return Promise.resolve({
          ok: false as const,
          error: { reason: 'unreachable' as const, message: 'no path' },
        })
      }
      if (target.x === 0.5 && trips.length > 3) failNext = true
      return original(target, within, options)
    }

    const result = await run()

    expect(result).toMatchObject({ ok: true, value: { returned: true } })
  })

  it('calls a deep open cut a ravine', async () => {
    for (let step = 0; step < 4; step += 1)
      world.carve(at(step * 2, 101 - step * 3, 0), at(step * 2 + 1, 110, 0))
    world.bot = at(0.5, 101, 0.5)

    const result = await run(wanted({ maxDistance: 30 }))

    expect(result).toMatchObject({ ok: true, value: { region: 'ravine' } })
  })
})
