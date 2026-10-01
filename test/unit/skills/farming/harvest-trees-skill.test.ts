import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import {
  HarvestTreesSkill,
  type HarvestTreesInput,
  type TowerBuilder,
} from '../../../../src/skills/farming/harvest-trees-skill.js'
import type { Scheduler } from '../../../../src/core/scheduler.port.js'
import type { Tower, TowerPlan } from '../../../../src/skills/construction/scaffolder.js'
import { FarmRegistry, type GroveSpot } from '../../../../src/state/farm-registry.js'
import { err, ok } from '../../../../src/core/result.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeInventory, FakeVitals } from '../../../fakes/fake-ports.js'
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
const rect = (x0: number, z0: number, x1: number, z1: number) => ({
  from: at(x0, GROUND, z0),
  to: at(x1, GROUND, z1),
})

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
  const drops = new DropCollector({
    drops: droppedItems,
    navigator,
    scheduler: new RecordingScheduler(clock, events),
  })
  const guard = new FakeAreaGuard()
  const farms = new FarmRegistry(clock)
  await farms.attach(new InMemoryStateStore())
  const deps = { blocks: world, navigator, digger, placer, drops, inventory, guard, farms }
  const skill = new HarvestTreesSkill(deps)
  const grove = (spots: readonly GroveSpot[] | undefined, label = 'wood') => {
    const entry = farms.register({
      kind: 'grove',
      crop: 'oak',
      bounds: rect(0, 0, 20, 20),
      label,
      spots,
    })
    if (!entry.ok) throw new Error(entry.error)
    return entry.value
  }
  return {
    world,
    digger,
    placer,
    navigator,
    guard,
    farms,
    carried,
    sync,
    skill,
    grove,
    events,
    droppedItems,
    deps,
  }
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
    for (const [x, z] of [
      [2, 2],
      [8, 8],
      [14, 14],
    ] as const)
      s.world.trunk(x, GROUND, z, 3)

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

    const without = await s.skill.run(
      input({ replant: false, maxTrees: 1 }),
      skillContext().context,
    )
    const lacking = await s.skill.run(input(), skillContext().context)

    expect(without).toMatchObject({
      ok: true,
      value: { trees: 1, replanted: 0, saplingsMissing: 0 },
    })
    expect(lacking).toMatchObject({
      ok: true,
      value: { trees: 1, replanted: 0, saplingsMissing: 1 },
    })
  })

  it('replants each trunk of a 2x2 tree with its own sapling', async () => {
    const s = await setup({ dark_oak_sapling: 4 })
    s.grove([spot(4, 4, 2)])
    for (const [x, z] of [
      [4, 4],
      [5, 4],
      [4, 5],
      [5, 5],
    ] as const)
      s.world.trunk(x, GROUND, z, 3, 'dark_oak_log')

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

/** A tower that only counts: cells are recorded, and the digger's reach grows with them. */
class FakeTowers implements TowerBuilder {
  readonly calls: string[] = []
  planTo: TowerPlan | undefined = { base: at(4, GROUND + 1, 2), height: 3 }
  raiseFails: 'aborted' | 'unreachable' | undefined
  pillarFails = false
  onLower: () => void = () => undefined

  requests: Parameters<TowerBuilder['plan']>[0][] = []

  plan(request: Parameters<TowerBuilder['plan']>[0]): TowerPlan | undefined {
    this.calls.push('plan')
    this.requests.push(request)
    return this.planTo
  }

  raise(plan: TowerPlan, block: string): ReturnType<TowerBuilder['raise']> {
    this.calls.push('raise')
    const tower: Tower = { base: plan.base, block, cells: [], leavesCut: plan.clear?.length ?? 0 }
    if (this.raiseFails !== undefined)
      return Promise.resolve(err({ reason: this.raiseFails, message: 'no', tower }))
    for (let level = 0; level < plan.height; level += 1)
      tower.cells.push({ ...plan.base, y: plan.base.y + level })
    return Promise.resolve(ok(tower))
  }

  pillarOnce(tower: Tower): ReturnType<TowerBuilder['pillarOnce']> {
    this.calls.push('pillar')
    if (this.pillarFails) return Promise.resolve(err({ reason: 'place_failed', message: 'no' }))
    tower.cells.push({ ...tower.base, y: tower.base.y + tower.cells.length })
    return Promise.resolve(ok(undefined))
  }

  lower(tower: Tower): Promise<Position[]> {
    this.calls.push('lower')
    tower.cells.length = 0
    this.onLower()
    return Promise.resolve([])
  }
}

describe('HarvestTreesSkill, tall trees', () => {
  async function tall(over: { dirt?: number; height?: number } = {}) {
    const s = await setup({ oak_sapling: 5, dirt: over.dirt ?? 12 })
    s.grove([spot(2, 2)])
    const height = over.height ?? 12
    s.world.trunk(2, GROUND, 2, height)
    const towers = new FakeTowers()
    const vitals = new FakeVitals()
    vitals.vitals = { position: at(3, GROUND + 1, 3) } as never
    // The bot reaches logs up to 4 blocks above the ground, plus the height of the tower it stands on.
    let tower: Tower | undefined
    const raise = towers.raise.bind(towers)
    towers.raise = async (plan, block) => {
      const result = await raise(plan, block)
      if (result.ok) tower = result.value
      return result
    }
    const dig = s.digger.dig.bind(s.digger)
    s.digger.dig = (position) => {
      const top = GROUND + 1 + 3 + (tower?.cells.length ?? 0)
      return position.y > top
        ? Promise.resolve({
            ok: false as const,
            error: { reason: 'out_of_reach' as const, message: 'too far' },
          })
        : dig(position)
    }
    const skill = new HarvestTreesSkill({ ...s.deps, scaffolder: towers, vitals })
    return { ...s, towers, skill }
  }

  it('climbs a tower for the logs the ground cannot reach, takes it down, and replants', async () => {
    const s = await tall()

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { trees: 1, logs: 12, left: 0, replanted: 1 } })
    expect(s.towers.calls[0]).toBe('plan')
    expect(s.towers.calls).toContain('raise')
    expect(s.towers.calls.at(-1)).toBe('lower')
    expect(s.world.blockAt(at(2, GROUND + 12, 2))).toBe('air')
    expect(s.world.blockAt(at(2, GROUND + 1, 2))).toBe('oak_sapling')
  })

  it('raises the tower a block at a time while the next log is still out of reach', async () => {
    const s = await tall({ height: 12 })
    s.towers.planTo = { base: at(4, GROUND + 1, 2), height: 1 }

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { left: 0 } })
    expect(s.towers.calls.filter((call) => call === 'pillar').length).toBeGreaterThan(0)
  })

  it('leaves the top and does not replant when the tower cannot be raised any more', async () => {
    const s = await tall({ height: 12 })
    s.towers.planTo = { base: at(4, GROUND + 1, 2), height: 1 }
    s.towers.pillarFails = true

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { trees: 0 } })
    expect(result.ok && result.value.left).toBeGreaterThan(0)
    expect(s.towers.calls.at(-1)).toBe('lower')
    expect(s.world.blockAt(at(2, GROUND + 1, 2))).not.toBe('oak_sapling')
  })

  it('leaves the tree and says how much dirt was missing', async () => {
    const s = await tall({ dirt: 1 })

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { trees: 0, scaffoldMissing: 2 } })
    expect(s.towers.calls).not.toContain('raise')
  })

  it('leaves the tree when there is no safe place for a tower', async () => {
    const s = await tall()
    s.towers.planTo = undefined

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { trees: 0 } })
    expect(s.towers.calls).toEqual(['plan'])
  })

  it.each(['unreachable', 'aborted'] as const)('takes a failed tower down (%s)', async (reason) => {
    const s = await tall()
    s.towers.raiseFails = reason

    const result = await s.skill.run(input(), skillContext().context)

    expect(s.towers.calls.at(-1)).toBe('lower')
    expect(result.ok ? result.value.trees : 'aborted').toBe(reason === 'aborted' ? 'aborted' : 0)
  })

  it('keeps today’s behavior with reachTall: skip', async () => {
    const s = await tall()

    const result = await s.skill.run(input({ reachTall: 'skip' }), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { trees: 0 } })
    expect(s.towers.calls).toEqual([])
  })

  it('leaves the high logs that lie inside a protected area', async () => {
    const s = await tall()
    s.guard.protect('a build', (p) => p.x === 2 && p.z === 2 && p.y >= GROUND + 10)

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { trees: 0, logs: 9, left: 3 } })
    expect(s.towers.calls.at(-1)).toBe('lower')
  })

  it('takes the tower down when cancelled halfway', async () => {
    const s = await tall()
    const context = skillContext()
    s.towers.onLower = () => undefined
    const dig = s.digger.dig.bind(s.digger)
    let count = 0
    s.digger.dig = (position) => {
      count += 1
      if (count === 6) context.controller.abort()
      return dig(position)
    }

    const result = await s.skill.run(input(), context.context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(s.towers.calls.at(-1)).toBe('lower')
  })
})

describe('HarvestTreesSkill, leaves in the way of the tower', () => {
  async function canopy() {
    const s = await setup({ oak_sapling: 5, dirt: 12 })
    s.grove([spot(2, 2)])
    s.world.trunk(2, GROUND, 2, 12)
    const towers = new FakeTowers()
    const vitals = new FakeVitals()
    vitals.vitals = { position: at(3, GROUND + 1, 3) } as never
    const dig = s.digger.dig.bind(s.digger)
    s.digger.dig = (position) =>
      position.y > GROUND + 4 && !towers.calls.includes('raise')
        ? Promise.resolve({
            ok: false as const,
            error: { reason: 'out_of_reach' as const, message: 'far' },
          })
        : dig(position)
    const skill = new HarvestTreesSkill({ ...s.deps, scaffolder: towers, vitals })
    return { ...s, towers, skill }
  }

  it('lets the planner run a tower through the tree’s own leaves, up to a limit', async () => {
    const s = await canopy()
    s.world.set(3, GROUND + 6, 3, 'oak_leaves')
    s.world.set(3, GROUND + 6, 4, 'birch_leaves')

    await s.skill.run(input(), skillContext().context)

    const request = s.towers.requests[0]
    expect(request?.maxClear).toBe(12)
    expect(request?.passable?.(at(3, GROUND + 6, 3))).toBe(true)
    expect(request?.passable?.(at(3, GROUND + 6, 4))).toBe(false) // another tree's leaves
    expect(request?.passable?.(at(3, GROUND + 7, 3))).toBe(false) // not a leaf at all
  })

  it('never cuts leaves inside somebody else’s protected area', async () => {
    const s = await canopy()
    s.world.set(3, GROUND + 6, 3, 'oak_leaves')
    s.guard.protect('roof', (p) => p.x === 3 && p.y === GROUND + 6 && p.z === 3)

    await s.skill.run(input(), skillContext().context)

    expect(s.towers.requests[0]?.passable?.(at(3, GROUND + 6, 3))).toBe(false)
  })

  it('reports how many leaves were cut', async () => {
    const s = await canopy()
    s.towers.planTo = {
      base: at(4, GROUND + 1, 2),
      height: 3,
      clear: [at(4, GROUND + 3, 2), at(4, GROUND + 4, 2)],
    }

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { leavesCut: 2 } })
  })

  it('reports no leaves cut when the tower needed none, or no tower was built', async () => {
    const clear = await canopy()
    const none = await clear.skill.run(input(), skillContext().context)
    const skipped = await clear.skill.run(input({ reachTall: 'skip' }), skillContext().context)

    expect(none).toMatchObject({ ok: true, value: { leavesCut: 0 } })
    expect(skipped).toMatchObject({ ok: true, value: { leavesCut: 0 } })
  })
})
