import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { ok } from '../../../../src/core/result.js'
import { CraftingSupplies } from '../../../../src/skills/construction/crafting-supplies.js'
import { SpoilDiscarder } from '../../../../src/skills/construction/spoil-discarder.js'
import type { CraftInput, CraftOutput } from '../../../../src/skills/crafting/craft-item-skill.js'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import { ItemThrower } from '../../../../src/skills/handover/item-thrower.js'
import { DropIgnoreList } from '../../../../src/skills/recovery/drop-ignore-list.js'
import { ConstructionWorld } from '../../../fakes/construction-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { AutoScheduler, FakeDroppedItems, skillContext } from '../../../fakes/gathering-fakes.js'
import { FakeInventoryWriter } from '../../../fakes/handover-fakes.js'
import { FakeStorageWorld } from '../../../fakes/storage-fakes.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })

describe('SpoilDiscarder', () => {
  function setup() {
    const world = new FakeStorageWorld()
    const clock = new FakeClock(0)
    const scheduler = new AutoScheduler(clock)
    const drops = new FakeDroppedItems()
    const ignore = new DropIgnoreList(clock)
    const discarder = new SpoilDiscarder({
      inventory: world.inventory,
      thrower: new ItemThrower(new FakeInventoryWriter(world, drops), scheduler),
      vitals: world.vitals,
      ignore,
    })
    return { world, drops, ignore, discarder }
  }

  it('throws away the junk beyond a stock of 64, and nothing else', async () => {
    const s = setup()
    s.world.carry('cobblestone', 300)
    s.world.carry('dirt', 60)
    s.world.carry('gravel', 100)
    s.world.carry('diamond', 5)
    s.world.carry('iron_pickaxe', 1)
    s.world.carry('coal_ore', 200)

    const got = await s.discarder.discard(skillContext().context)

    expect(got).toBe(236 + 36)
    expect(s.world.have('cobblestone')).toBe(64)
    expect(s.world.have('dirt')).toBe(60)
    expect(s.world.have('gravel')).toBe(64)
    expect(s.world.have('diamond')).toBe(5)
    expect(s.world.have('iron_pickaxe')).toBe(1)
    expect(s.world.have('coal_ore')).toBe(200)
  })

  it('does nothing when there is no excess', async () => {
    const s = setup()
    s.world.carry('cobblestone', 64)

    expect(await s.discarder.discard(skillContext().context)).toBe(0)
    expect(s.world.have('cobblestone')).toBe(64)
  })

  it('remembers what it threw and where, so the drop collector leaves it', async () => {
    const s = setup()
    s.world.carry('cobblestone', 200)
    await s.discarder.discard(skillContext().context)
    const lying = {
      entityId: 1,
      name: 'cobblestone',
      count: 100,
      position: at(2, 64, 0),
      distance: 2,
    }
    const other = { ...lying, entityId: 2, name: 'iron_ore' }

    expect(s.ignore.isIgnored(lying)).toBe(true)
    expect(s.ignore.isIgnored(other)).toBe(false)
  })
})

describe('DropCollector: leaving things lying', () => {
  it('does not walk to items the skip test rejects', async () => {
    const world = new ConstructionWorld()
    const drops = new FakeDroppedItems()
    drops.drop('cobblestone', at(2, 64, 0), 2)
    drops.drop('iron_ore', at(4, 64, 0), 4)
    const collector = new DropCollector({
      drops,
      navigator: world,
      scheduler: new AutoScheduler(new FakeClock(0)),
      skip: (item) => item.name === 'cobblestone',
    })

    await collector.collect({ maxDistance: 12 }, new AbortController().signal)

    expect(world.trips.map((t) => t.x)).toEqual([4])
  })
})

describe('CraftingSupplies', () => {
  const crafter = (result: (input: CraftInput) => number) => {
    const asked: CraftInput[] = []
    const supplies = new CraftingSupplies({
      run: (input) => {
        asked.push(input)
        const produced = result(input)
        const value: CraftOutput = { item: input.item, produced, steps: [], placedTable: false }
        return Promise.resolve(ok(value))
      },
    })
    return { asked, supplies }
  }

  it('crafts through the craft skill and says whether anything came out', async () => {
    const { asked, supplies } = crafter(() => 8)

    expect(await supplies.craft('torch', 8, skillContext().context)).toBe(true)
    expect(asked).toEqual([{ item: 'torch', count: 8 }])
  })

  it('says no when nothing was made, or the craft failed', async () => {
    expect(await crafter(() => 0).supplies.craft('torch', 8, skillContext().context)).toBe(false)
    const failing = new CraftingSupplies({
      run: () =>
        Promise.resolve({ ok: false, error: { reason: 'missing_materials', message: 'no coal' } }),
    })
    expect(await failing.craft('torch', 8, skillContext().context)).toBe(false)
  })
})
