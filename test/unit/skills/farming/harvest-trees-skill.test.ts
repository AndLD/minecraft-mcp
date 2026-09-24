import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import {
  HarvestTreesSkill,
  type HarvestTreesInput,
} from '../../../../src/skills/farming/harvest-trees-skill.js'
import type { Scheduler } from '../../../../src/core/scheduler.port.js'
import { FarmRegistry, type GroveSpot } from '../../../../src/state/farm-registry.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeInventory } from '../../../fakes/fake-ports.js'
import {
  AutoScheduler,
  FakeAreaGuard,
  FakeDroppedItems,
  InstantNavigator,
  skillContext,
} from '../../../fakes/gathering-fakes.js'
import { GroveDigger, GrovePlacer, GroveWorld } from '../../../fakes/grove-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const GROUND = 64
const at = (x: number, y: number, z: number): Position => ({ x, y, z })
const rect = (x0: number, z0: number, x1: number, z1: number) => ({ from: at(x0, GROUND, z0), to: at(x1, GROUND, z1) })

/** An auto scheduler that notes every wait, so a test can see when the bot stopped to pick something up. */
class RecordingScheduler extends AutoScheduler implements Scheduler {
  constructor(
    clock: FakeClock,
    private readonly events: string[],
  ) {
    super(clock)
  }

  override after(delayMs: number, callback: () => void): () => void {
    this.events.push(`wait ${String(delayMs)}`)
    return super.after(delayMs, callback)
  }
}

async function setup(saplings: Record<string, number> = { oak_sapling: 5 }) {
  const world = new GroveWorld({ x0: -10, x1: 40, z0: -10, z1: 40, y0: 50, y1: 100 })
  world.ground(-10, -10, 40, 40, GROUND)
  const carried = new Map(Object.entries(saplings))
  const inventory = new FakeInventory()
  const sync = (): void => {
    inventory.value = {
      stacks: [...carried].map(([name, count]) => ({ name, count })),
      emptySlots: 20,
      heldItem: undefined,
    }
  }
  sync()
  const digger = new GroveDigger(world)
  digger.onDug = (_position, name) => {
    carried.set(name, (carried.get(name) ?? 0) + 1)
    sync()
  }
  const placer = new GrovePlacer(world)
  placer.onPlaced = (item) => {
    carried.set(item, (carried.get(item) ?? 0) - 1)
    sync()
  }
  const navigator = new InstantNavigator()
  const clock = new FakeClock(0)
  const events: string[] = []
  const droppedItems = new FakeDroppedItems()
  const drops = new DropCollector({ drops: droppedItems, navigator, scheduler: new RecordingScheduler(clock, events) })
  const guard = new FakeAreaGuard()
  const farms = new FarmRegistry(clock)
  await farms.attach(new InMemoryStateStore())
  const skill = new HarvestTreesSkill({ blocks: world, navigator, digger, placer, drops, inventory, guard, farms })
  const grove = (spots: readonly GroveSpot[] | undefined, label = 'wood') => {
    const entry = farms.register({ kind: 'grove', crop: 'oak', bounds: rect(0, 0, 20, 20), label, spots })
    if (!entry.ok) throw new Error(entry.error)
    return entry.value
  }
  return { world, digger, placer, navigator, guard, farms, carried, sync, skill, grove, events, droppedItems }
}

const input = (over: Partial<HarvestTreesInput> = {}): HarvestTreesInput => ({
  farm: 'wood',
  area: undefined,
  replant: true,
  maxTrees: undefined,
  ...over,
})
const spot = (x: number, z: number, size: 1 | 2 = 1): GroveSpot => ({ x, y: GROUND + 1, z, size })

describe('HarvestTreesSkill', () => {
  it('fells a grown tree of a grove from the bottom up and replants its spot', async () => {
    const s = await setup()
    s.grove([spot(2, 2), spot(8, 8)])
    s.world.trunk(2, GROUND, 2, 4)
    s.world.set(8, GROUND + 1, 8, 'oak_sapling')

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { trees: 1, logs: 4, left: 0, replanted: 1, saplingsMissing: 0 },
    })
    expect(s.digger.dug.map((p) => p.y)).toEqual([65, 66, 67, 68])
    expect(s.world.blockAt(at(2, GROUND + 1, 2))).toBe('oak_sapling')
    expect(s.world.blockAt(at(8, GROUND + 1, 8))).toBe('oak_sapling')
    expect(result.ok && result.value.gained).toContainEqual({ name: 'oak_log', count: 4 })
  })

  it('picks up each log’s drop right after breaking it, not once for the whole tree', async () => {
    const s = await setup({})
    s.grove([spot(2, 2)])
    s.world.trunk(2, GROUND, 2, 3)
    const dig = s.digger.onDug
    s.digger.onDug = (position, name) => {
      dig(position, name)
      s.events.push('dig')
    }

    await s.skill.run(input({ replant: false }), skillContext().context)

    const digs = s.events.flatMap((event, index) => (event === 'dig' ? [index] : []))
    expect(digs).toHaveLength(3)
    for (const [i, at] of digs.slice(0, -1).entries()) {
      const between = s.events.slice(at + 1, digs[i + 1])
      expect(between).toContain('wait 350')
    }
  })

  it('follows branches that touch the trunk', async () => {
    const s = await setup()
    s.grove([spot(2, 2)])
    s.world.trunk(2, GROUND, 2, 3)
    s.world.set(3, GROUND + 3, 2, 'oak_log')
    s.world.set(4, GROUND + 4, 2, 'oak_log')

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { trees: 1, logs: 5, left: 0 } })
  })

  it('does not touch a different wood next to the trunk', async () => {
    const s = await setup()
    s.grove([spot(2, 2)])
    s.world.trunk(2, GROUND, 2, 2)
    s.world.set(3, GROUND + 1, 2, 'birch_log')

    await s.skill.run(input(), skillContext().context)

    expect(s.world.blockAt(at(3, GROUND + 1, 2))).toBe('birch_log')
  })

  it('leaves saplings and empty spots alone', async () => {
    const s = await setup()
    s.grove([spot(2, 2), spot(8, 8)])
    s.world.set(2, GROUND + 1, 2, 'oak_sapling')

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { trees: 0, logs: 0 } })
    expect(s.digger.dug).toEqual([])
  })

  it('stops at the requested number of trees', async () => {
    const s = await setup()
    s.grove([spot(2, 2), spot(8, 8), spot(14, 14)])
    for (const [x, z] of [[2, 2], [8, 8], [14, 14]] as const) s.world.trunk(x, GROUND, z, 3)

    const result = await s.skill.run(input({ maxTrees: 2 }), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { trees: 2 } })
    expect(s.world.blockAt(at(14, GROUND + 1, 14))).toBe('oak_log')
  })

  it('steps closer when the first try is out of reach', async () => {
    const s = await setup()
    s.grove([spot(2, 2)])
    s.world.trunk(2, GROUND, 2, 1)
    s.digger.farFirst.add('2,65,2')

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { trees: 1, logs: 1 } })
    expect(s.navigator.trips.map((t) => t.within)).toEqual([3, 1.5])
  })

  it('leaves the top of a tree it cannot reach, and does not replant under it', async () => {
    const s = await setup()
    s.grove([spot(2, 2)])
    s.world.trunk(2, GROUND, 2, 5)
    s.digger.unreachable.add('2,68,2')
    s.digger.unreachable.add('2,69,2')

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { trees: 0, logs: 3, left: 2, replanted: 0 },
    })
    expect(s.placer.placed).toEqual([])
  })

  it('does not cut logs inside a protected area that is not the grove’s own', async () => {
    const s = await setup()
    s.grove([spot(2, 2)])
    s.world.trunk(2, GROUND, 2, 3)
    s.guard.protect('house', (p) => p.y >= GROUND + 3)

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { logs: 2, left: 1, trees: 0 } })
  })

  it('cuts inside the grove’s own protection', async () => {
    const s = await setup()
    s.grove([spot(2, 2)], 'wood')
    s.world.trunk(2, GROUND, 2, 3)
    s.guard.protect('wood', () => true)

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { trees: 1, logs: 3 } })
  })

  it('does not replant when told not to, or reports the saplings it lacks', async () => {
    const s = await setup({})
    s.grove([spot(2, 2), spot(8, 8)])
    s.world.trunk(2, GROUND, 2, 2)
    s.world.trunk(8, GROUND, 8, 2)

    const without = await s.skill.run(input({ replant: false, maxTrees: 1 }), skillContext().context)
    const lacking = await s.skill.run(input(), skillContext().context)

    expect(without).toMatchObject({ ok: true, value: { trees: 1, replanted: 0, saplingsMissing: 0 } })
    expect(lacking).toMatchObject({ ok: true, value: { trees: 1, replanted: 0, saplingsMissing: 1 } })
  })

  it('replants each trunk of a 2x2 tree with its own sapling', async () => {
    const s = await setup({ dark_oak_sapling: 4 })
    s.grove([spot(4, 4, 2)])
    for (const [x, z] of [[4, 4], [5, 4], [4, 5], [5, 5]] as const) s.world.trunk(x, GROUND, z, 3, 'dark_oak_log')

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { trees: 1, logs: 12, replanted: 4 } })
    expect(s.placer.placed).toHaveLength(4)
  })

  describe('in an area, with no recorded spots', () => {
    it('fells trunks standing on dirt inside it, and not what is outside or built', async () => {
      const s = await setup()
      s.world.trunk(3, GROUND, 3, 3)
      s.world.trunk(30, GROUND, 30, 3) // outside the area
      s.world.set(6, GROUND + 6, 6, 'oak_log') // a log with nothing below it: part of a build
      s.world.trunk(9, GROUND, 9, 2)
      s.world.set(9, GROUND, 9, 'stone') // trunk on stone: not grown here

      const result = await s.skill.run(
        input({ farm: undefined, area: rect(0, 0, 12, 12) }),
        skillContext().context,
      )

      expect(result).toMatchObject({ ok: true, value: { trees: 1, logs: 3 } })
      expect(s.world.blockAt(at(30, GROUND + 1, 30))).toBe('oak_log')
      expect(s.world.blockAt(at(6, GROUND + 6, 6))).toBe('oak_log')
    })

    it('works on a grove registered by hand, which has no spots', async () => {
      const s = await setup()
      s.grove(undefined)
      s.world.trunk(3, GROUND, 3, 2)

      const result = await s.skill.run(input(), skillContext().context)

      expect(result).toMatchObject({ ok: true, value: { trees: 1, replanted: 1 } })
    })

    it('finds nothing to fell when no log names are known', async () => {
      const s = await setup()
      s.world.names = ['air', 'dirt']

      const result = await s.skill.run(
        input({ farm: undefined, area: rect(0, 0, 12, 12) }),
        skillContext().context,
      )

      expect(result).toMatchObject({ ok: true, value: { trees: 0 } })
    })
  })

  it('reports what it did when cancelled', async () => {
    const s = await setup()
    s.grove([spot(2, 2), spot(8, 8)])
    s.world.trunk(2, GROUND, 2, 2)
    s.world.trunk(8, GROUND, 8, 2)
    const { context, controller } = skillContext()
    s.digger.onDug = () => {
      controller.abort()
    }

    const result = await s.skill.run(input(), context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
  })

  it.each([
    ['an unknown farm', { farm: 'nothing' }, 'unknown_farm'],
    ['no grove or area', { farm: undefined }, 'no_area'],
  ])('refuses %s', async (_name, over, reason) => {
    const s = await setup()

    const result = await s.skill.run(input(over), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason } })
  })

  it('refuses a farm that is not a grove', async () => {
    const s = await setup()
    s.farms.register({ kind: 'field', bounds: rect(0, 0, 4, 4), label: 'wheat' })

    const result = await s.skill.run(input({ farm: 'wheat' }), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'not_a_grove' } })
  })
})
