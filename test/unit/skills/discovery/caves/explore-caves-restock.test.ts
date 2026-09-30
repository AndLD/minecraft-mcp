import { beforeEach, describe, expect, it } from '@jest/globals'
import { WorldKnowledgeStore } from '../../../../../src/knowledge/world-knowledge-store.js'
import { HazardRule } from '../../../../../src/skills/construction/hazard-rule.js'
import { SiteSafety } from '../../../../../src/skills/construction/site-safety.js'
import { CaveMap } from '../../../../../src/skills/discovery/caves/cave-map.js'
import {
  ExploreCavesSkill,
  type ExploreCavesInput,
} from '../../../../../src/skills/discovery/caves/explore-caves-skill.js'
import { FindDetector } from '../../../../../src/skills/discovery/caves/find-rules.js'
import { LightManager } from '../../../../../src/skills/discovery/caves/light-manager.js'
import type {
  Restocked,
  TorchRestocker,
} from '../../../../../src/skills/discovery/caves/torch-supply.js'
import { VeinMiner } from '../../../../../src/skills/discovery/caves/vein-miner.js'
import { StructureScanner } from '../../../../../src/skills/discovery/structure-scanner.js'
import { defaultSignatures } from '../../../../../src/skills/discovery/structure-signatures.js'
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

/** A supply that hands out what a test scripts, one answer per call, and records where the bot was. */
class ScriptedSupply implements TorchRestocker {
  readonly calls: { at: { x: number; y: number; z: number }; targeted: number }[] = []
  /** Torches to hand over on each call, in order; nothing when the script is empty. */
  script: number[] = []

  constructor(private readonly world: CaveWorld) {}

  carried(): number {
    return this.world.carried.get('torch') ?? 0
  }

  restock(target: number): Promise<Restocked> {
    this.calls.push({ at: { ...this.world.bot }, targeted: target })
    const give = this.script.shift() ?? 0
    if (give > 0) this.world.give('torch', give)
    return Promise.resolve({ torches: give, crafted: 0 })
  }
}

describe('ExploreCavesSkill, torches from storage', () => {
  let world: CaveWorld
  let supply: ScriptedSupply
  let controller: AbortController
  let skill: ExploreCavesSkill

  const tunnel = (length = 40) => {
    world.carve(at(0, 60, 0), at(length, 61, 0))
    world.bot = at(0.5, 60, 0.5)
  }

  beforeEach(async () => {
    world = new CaveWorld()
    supply = new ScriptedSupply(world)
    const clock = new FakeClock(0)
    const knowledge = new WorldKnowledgeStore(clock)
    await knowledge.attach(new InMemoryStateStore())
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
      torchSupply: supply,
    })
  })

  const run = (input: ExploreCavesInput = wanted()) =>
    skill.run(input, { signal: controller.signal, progress: () => undefined })

  it('fetches torches before going in when it carries few, and reports it', async () => {
    tunnel()
    world.carried.set('torch', 2)
    supply.script = [62]

    const result = await run()

    expect(supply.calls).toHaveLength(1)
    expect(supply.calls[0]?.targeted).toBe(64)
    expect(result).toMatchObject({
      ok: true,
      value: { restocked: { torches: 62, trips: 1 }, returned: true },
    })
    expect((result.ok && result.value.torchesPlaced) || 0).toBeGreaterThan(2)
  })

  it('does not fetch when it already carries enough', async () => {
    tunnel()
    world.give('torch', 20)

    const result = await run()

    expect(supply.calls).toEqual([])
    expect(result).toMatchObject({ ok: true, value: { restocked: { torches: 0, trips: 0 } } })
  })

  it('does not fetch when told not to', async () => {
    tunnel()

    const result = await run(wanted({ restock: false }))

    expect(supply.calls).toEqual([])
    expect(result).toMatchObject({ ok: true, value: { stopped: 'no_torches' } })
  })

  it('walks out when the torches run out, fetches more, and goes back in to carry on', async () => {
    tunnel(180)
    world.give('torch', 8) // enough at the start, so nothing is fetched before going in
    supply.script = [40]

    const result = await run(wanted({ maxDistance: 300 }))

    expect(supply.calls).toHaveLength(1)
    expect(supply.calls[0]?.at.x).toBeLessThan(5) // fetched outside, near the start
    expect(result).toMatchObject({
      ok: true,
      value: { restocked: { torches: 40, trips: 1 }, stopped: 'explored' },
    })
    expect((result.ok && result.value.torchesPlaced) || 0).toBeGreaterThan(8)
  })

  it('ends with no_torches, back outside, when storage has none either', async () => {
    tunnel(100)
    world.give('torch', 8)

    const result = await run(wanted({ maxDistance: 200 }))

    expect(result).toMatchObject({
      ok: true,
      value: { stopped: 'no_torches', restocked: { torches: 0, trips: 0 }, returned: true },
    })
    expect(supply.calls.length).toBeGreaterThan(0)
  })

  it('gives up after two trips out for torches', async () => {
    tunnel(400)
    world.give('torch', 8)
    supply.script = [4, 4, 4, 4]

    const result = await run(wanted({ maxDistance: 500 }))

    expect(supply.calls.length).toBeLessThanOrEqual(3)
    expect(result).toMatchObject({ ok: true, value: { stopped: 'no_torches' } })
  })

  it('reports a cancel while fetching torches', async () => {
    tunnel()
    supply.restock = () => {
      controller.abort()
      return Promise.resolve({ torches: 0, crafted: 0 })
    }

    const result = await run()

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
  })
})
