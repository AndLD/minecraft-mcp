import { beforeEach, describe, expect, it } from '@jest/globals'
import { ok } from '../../src/core/result.js'
import type { Position } from '../../src/core/position.types.js'
import { WorldKnowledgeStore } from '../../src/knowledge/world-knowledge-store.js'
import { BlockFinder } from '../../src/perception/block-finder.js'
import { HazardRule } from '../../src/skills/construction/hazard-rule.js'
import { SiteSafety } from '../../src/skills/construction/site-safety.js'
import { CaveMap } from '../../src/skills/discovery/caves/cave-map.js'
import { ExploreCavesSkill } from '../../src/skills/discovery/caves/explore-caves-skill.js'
import { FindDetector } from '../../src/skills/discovery/caves/find-rules.js'
import { LightManager } from '../../src/skills/discovery/caves/light-manager.js'
import { VeinMiner } from '../../src/skills/discovery/caves/vein-miner.js'
import { StructureScanner } from '../../src/skills/discovery/structure-scanner.js'
import { defaultSignatures } from '../../src/skills/discovery/structure-signatures.js'
import { CollectBlocksSkill } from '../../src/skills/gathering/collect-blocks-skill.js'
import type { DropCollector } from '../../src/skills/gathering/drop-collector.js'
import {
  OpenVeinGatherSkill,
  type OpenVeinInput,
} from '../../src/skills/gathering/open-vein-gather-skill.js'
import { CaveWorld } from '../fakes/cave-fakes.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { InMemoryStateStore } from '../fakes/state-fakes.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })

const wanted = (patch: Partial<OpenVeinInput> = {}): OpenVeinInput => ({
  names: ['iron_ore'],
  count: 1,
  maxDistance: 32,
  maxMinutes: 10,
  tunnel: false,
  ...patch,
})

/** Gathering ore: what is in view and can be walked to first, then caves, then (only when asked) a tunnel. */
describe('open-vein gathering', () => {
  let world: CaveWorld
  let clock: FakeClock
  let tunnelled: Position[]
  let skill: OpenVeinGatherSkill
  let progress: string[]

  beforeEach(async () => {
    world = new CaveWorld()
    world.give('torch', 30)
    world.known.push('iron_ore')
    clock = new FakeClock(0)
    tunnelled = []
    progress = []
    const knowledge = new WorldKnowledgeStore(clock)
    await knowledge.attach(new InMemoryStateStore())
    const finder = new BlockFinder(world)
    const collect = new CollectBlocksSkill({
      blocks: world,
      finder,
      digger: world,
      navigator: world,
      inventory: world,
      vitals: world,
      drops: { collectNear: () => Promise.resolve() } as unknown as DropCollector,
      guard: world,
    })
    const explore = new ExploreCavesSkill({
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
    skill = new OpenVeinGatherSkill({
      collect,
      explore,
      tunneler: {
        tunnelTo: (target) => {
          tunnelled.push(target)
          world.setBlock(target, 'air') // the route ends by breaking the vein
          return Promise.resolve(ok(undefined))
        },
      },
      blocks: world,
      finder,
      map: new CaveMap(world),
      vitals: world,
      inventory: world,
      clock,
    })
  })

  /** A tunnel along x at y 60, with the bot at its west end. */
  const tunnel = (length = 70) => {
    world.carve(at(0, 60, 0), at(length, 61, 0))
    world.bot = at(0.5, 60, 0.5)
  }

  const run = (input: OpenVeinInput = wanted()) =>
    skill.run(input, {
      signal: new AbortController().signal,
      progress: (message) => progress.push(message),
    })

  it('digs a vein that is in view and can be walked to, without exploring', async () => {
    tunnel()
    world.setBlock(at(10, 60, 1), 'iron_ore')

    const result = await run()

    expect(result).toMatchObject({ ok: true, value: { mined: 1, explored: 0, tunnelled: 0 } })
    expect(world.nameAt(at(10, 60, 1))).toBe('air')
    expect(progress.some((line) => line.includes('exploring caves'))).toBe(false)
  })

  it('explores the cave for a vein that is out of view, then digs it', async () => {
    tunnel()
    world.setBlock(at(60, 60, 1), 'iron_ore')

    const result = await run()

    expect(result).toMatchObject({ ok: true, value: { mined: 1, explored: 1, tunnelled: 0 } })
    expect(world.nameAt(at(60, 60, 1))).toBe('air')
    expect(progress.some((line) => line.includes('exploring caves'))).toBe(true)
    expect(world.torchCells().length).toBeGreaterThan(2)
    // It stays where the vein was: no walk back to the start.
    expect(world.bot.x).toBeGreaterThan(40)
  })

  it('takes the count over several veins, near ones first', async () => {
    tunnel()
    world.setBlock(at(10, 60, 1), 'iron_ore')
    world.setBlock(at(20, 60, 1), 'iron_ore')
    world.setBlock(at(62, 60, 1), 'iron_ore')

    const result = await run(wanted({ count: 3 }))

    expect(result).toMatchObject({ ok: true, value: { mined: 3, explored: 1 } })
  })

  it('does not count a vein in a sealed pocket as open, and does not tunnel to it', async () => {
    tunnel(20)
    world.carve(at(30, 60, 10), at(32, 61, 10)) // a pocket of air nobody can walk to
    world.setBlock(at(31, 60, 11), 'iron_ore')

    const result = await run()

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_open_vein' } })
    expect(world.nameAt(at(31, 60, 11))).toBe('iron_ore')
    expect(tunnelled).toEqual([])
  })

  it('names a buried vein and how to reach it, and tunnels to it only when asked', async () => {
    tunnel(20)
    world.setBlock(at(10, 60, 6), 'iron_ore') // in solid rock: no open face

    const open = await run()
    expect(open).toMatchObject({
      ok: false,
      error: { reason: 'no_open_vein', message: expect.stringContaining('open_then_tunnel') },
    })
    expect(tunnelled).toEqual([])

    const tunnelling = await run(wanted({ tunnel: true }))
    expect(tunnelling).toMatchObject({ ok: true, value: { mined: 1, tunnelled: 1 } })
    expect(tunnelled).toEqual([at(10, 60, 6)])
  })

  it('does not loop when the route did not remove the vein', async () => {
    tunnel(20)
    world.setBlock(at(10, 60, 6), 'iron_ore')
    const stubborn = new OpenVeinGatherSkill({
      ...(skill as unknown as { deps: ConstructorParameters<typeof OpenVeinGatherSkill>[0] }).deps,
      tunneler: { tunnelTo: () => Promise.resolve(ok(undefined)) },
    })

    const result = await stubborn.run(wanted({ tunnel: true }), {
      signal: new AbortController().signal,
      progress: () => undefined,
    })

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_open_vein' } })
  })

  it('passes on what the collector says when it must stop: no tool, full inventory', async () => {
    tunnel()
    world.setBlock(at(10, 60, 1), 'iron_ore')
    world.needsTool.set('iron_ore', 'stone_pickaxe')
    world.hasTool = false

    expect(await run()).toMatchObject({ ok: false, error: { reason: 'no_suitable_tool' } })

    world.hasTool = true
    world.emptySlots = 0
    expect(await run()).toMatchObject({ ok: false, error: { reason: 'inventory_full' } })
  })

  it('reports how many it got when it runs out of veins', async () => {
    tunnel()
    world.setBlock(at(10, 60, 1), 'iron_ore')

    const result = await run(wanted({ count: 3 }))

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'no_open_vein', detail: { mined: 1, requested: 3, remaining: 2 } },
    })
  })

  it('gives up on time, and when there is no cave to explore', async () => {
    world.bot = at(0.5, 101, 0.5) // open ground, nothing underneath

    expect(await run()).toMatchObject({ ok: false, error: { reason: 'no_open_vein' } })

    tunnel()
    world.onPlaced = () => { clock.advance(20 * 60_000); }
    expect(await run(wanted({ maxMinutes: 5 }))).toMatchObject({
      ok: false,
      error: { reason: 'no_open_vein' },
    })
  })

  it('stops at once when cancelled', async () => {
    tunnel()
    const controller = new AbortController()
    controller.abort()

    const result = await skill.run(wanted(), {
      signal: controller.signal,
      progress: () => undefined,
    })

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
  })

  it('takes the ore group and leaves lava-side veins alone', async () => {
    tunnel()
    world.setBlock(at(10, 60, 1), 'iron_ore')
    world.setBlock(at(10, 60, 2), 'lava')
    world.setBlock(at(20, 60, 1), 'coal_ore')
    world.known.push('coal_ore')

    const result = await run(wanted({ names: ['ores'] }))

    expect(result).toMatchObject({ ok: true, value: { mined: 1 } })
    expect(world.nameAt(at(20, 60, 1))).toBe('air')
    expect(world.nameAt(at(10, 60, 1))).toBe('iron_ore')
  })
})
