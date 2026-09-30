import { describe, expect, it } from '@jest/globals'
import { MineflayerItemFacts } from '../../../../../src/bot/mineflayer-item-facts.js'
import type { SupplyCrafter } from '../../../../../src/skills/construction/crafting-supplies.js'
import { TorchSupply } from '../../../../../src/skills/discovery/caves/torch-supply.js'
import { ScanContainersSkill } from '../../../../../src/skills/storage/scan-containers-skill.js'
import { ContainerVisitor } from '../../../../../src/skills/storage/container-visitor.js'
import { WithdrawItemsSkill } from '../../../../../src/skills/storage/withdraw-items-skill.js'
import { ContainerIndex } from '../../../../../src/state/container-index.js'
import { FakeBot } from '../../../../fakes/fake-bot.js'
import { FakeClock } from '../../../../fakes/fake-clock.js'
import { skillContext } from '../../../../fakes/gathering-fakes.js'
import { InMemoryStateStore } from '../../../../fakes/state-fakes.js'
import { FakeStorageWorld } from '../../../../fakes/storage-fakes.js'

const facts = new MineflayerItemFacts({
  current: () => new FakeBot().useGameData(),
  onChange: () => () => undefined,
})
const at = (x: number) => ({ x, y: 64, z: 0 })

async function setup() {
  const world = new FakeStorageWorld()
  const index = new ContainerIndex(new FakeClock())
  await index.attach(new InMemoryStateStore())
  const visitor = new ContainerVisitor({
    blocks: world.scanner,
    navigator: world.navigator,
    containers: world,
    index,
  })
  const withdraw = new WithdrawItemsSkill({
    inventory: world.inventory,
    vitals: world.vitals,
    index,
    visitor,
    facts,
  })
  const crafted: number[] = []
  /** Four torches per coal (or charcoal) and stick, like the game. */
  const supplies: SupplyCrafter = {
    craft: (_item, count) => {
      const fuel = world.have('coal') + world.have('charcoal')
      const sticks = world.have('stick')
      const units = Math.min(Math.ceil(count / 4), fuel, sticks)
      if (units <= 0) return Promise.resolve(false)
      world.carried.set('coal', world.have('coal') - Math.min(units, world.have('coal')))
      const rest = units - Math.min(units, world.have('coal'))
      world.carried.set('charcoal', world.have('charcoal') - Math.max(0, rest))
      world.carried.set('stick', sticks - units)
      world.carry('torch', units * 4)
      crafted.push(units * 4)
      return Promise.resolve(true)
    },
  }
  const scanner = new ScanContainersSkill({ vitals: world.vitals, index, visitor })
  const supply = new TorchSupply({ inventory: world.inventory, withdraw, supplies, scanner })
  const blind = new TorchSupply({ inventory: world.inventory, withdraw, supplies })
  /** A chest with a label, registered; its position is at(x). */
  const chest = (x: number, label: string, guarded = false): void => {
    world.addContainer(at(x))
    index.register(at(x), 'chest', { label, protected: guarded })
  }
  const refresh = (x: number): void => {
    // The index remembers what a container held when it was last opened: open it once so it knows.
    const entry = index.at(at(x))
    if (entry === undefined) throw new Error('no such container')
    const container = world.containers.get(`${String(x)},64,0`)
    index.recordContents(
      entry.id,
      [...(container?.stacks ?? [])].map(([name, count]) => ({ name, count })),
      { totalSlots: 27, emptySlots: 27 },
    )
  }
  return { world, supply, blind, chest, refresh, crafted }
}

describe('TorchSupply', () => {
  it('does nothing when enough torches are carried', async () => {
    const s = await setup()
    s.world.carry('torch', 40)

    const got = await s.supply.restock(32, skillContext().context)

    expect(got).toEqual({ torches: 0, crafted: 0 })
    expect(s.world.opened).toEqual([])
  })

  it('takes ready-made torches from a chest up to the target', async () => {
    const s = await setup()
    s.chest(10, 'lamps')
    s.world.stock(at(10), 'torch', 100)
    s.refresh(10)

    const got = await s.supply.restock(64, skillContext().context)

    expect(got).toEqual({ torches: 64, crafted: 0 })
    expect(s.world.have('torch')).toBe(64)
    expect(s.world.inside(at(10), 'torch')).toBe(36)
  })

  it('looks into the containers when memory holds no torches, and finds them in a chest it never opened', async () => {
    const s = await setup()
    s.chest(10, 'lamps') // registered, never opened: the index does not know what is in it
    s.world.stock(at(10), 'torch', 100)

    const got = await s.supply.restock(64, skillContext().context)

    expect(got).toEqual({ torches: 64, crafted: 0 })
    expect(s.world.opened).toContain('10,64,0')
  })

  it('does not look into containers when memory already has the torches', async () => {
    const s = await setup()
    s.chest(10, 'lamps')
    s.world.stock(at(10), 'torch', 100)
    s.refresh(10)

    await s.supply.restock(32, skillContext().context)

    expect(s.world.opened).toEqual(['10,64,0']) // one visit: the withdrawal, and no scan
  })

  it('without a scanner, an unopened chest is not used', async () => {
    const s = await setup()
    s.chest(10, 'lamps')
    s.world.stock(at(10), 'torch', 100)

    const got = await s.blind.restock(64, skillContext().context)

    expect(got.torches).toBe(0)
  })

  it('tops up to the target, not from zero', async () => {
    const s = await setup()
    s.world.carry('torch', 5)
    s.chest(10, 'lamps')
    s.world.stock(at(10), 'torch', 100)
    s.refresh(10)

    const got = await s.supply.restock(20, skillContext().context)

    expect(got.torches).toBe(15)
    expect(s.world.have('torch')).toBe(20)
  })

  it('makes up the difference from coal and sticks in storage', async () => {
    const s = await setup()
    s.chest(10, 'lamps')
    s.chest(20, 'materials')
    s.world.stock(at(10), 'torch', 20)
    s.world.stock(at(20), 'coal', 3)
    s.world.stock(at(20), 'stick', 10)
    s.refresh(10)
    s.refresh(20)

    const got = await s.supply.restock(64, skillContext().context)

    expect(got).toEqual({ torches: 32, crafted: 12 })
    expect(s.crafted).toEqual([12])
    expect(s.world.have('torch')).toBe(32)
    expect(s.world.inside(at(20), 'stick')).toBe(7)
  })

  it('uses charcoal when there is no coal', async () => {
    const s = await setup()
    s.chest(10, 'materials')
    s.world.stock(at(10), 'charcoal', 2)
    s.world.stock(at(10), 'stick', 2)
    s.refresh(10)

    const got = await s.supply.restock(8, skillContext().context)

    expect(got).toEqual({ torches: 8, crafted: 8 })
    expect(s.world.have('charcoal')).toBe(0)
  })

  it('uses coal and sticks it already carries before asking storage for them', async () => {
    const s = await setup()
    s.world.carry('coal', 2)
    s.world.carry('stick', 2)

    const got = await s.supply.restock(8, skillContext().context)

    expect(got).toEqual({ torches: 8, crafted: 8 })
    expect(s.world.opened).toEqual([])
  })

  it('gets nothing when storage holds nothing useful', async () => {
    const s = await setup()
    s.chest(10, 'junk')
    s.world.stock(at(10), 'cobblestone', 50)
    s.refresh(10)

    const got = await s.supply.restock(64, skillContext().context)

    expect(got).toEqual({ torches: 0, crafted: 0 })
  })

  it('never opens a protected container', async () => {
    const s = await setup()
    s.chest(10, 'treasure', true)
    s.world.stock(at(10), 'torch', 100)
    s.refresh(10)

    const got = await s.supply.restock(64, skillContext().context)

    expect(got.torches).toBe(0)
    expect(s.world.opened).toEqual([])
  })

  it('takes from the nearest container that has them first', async () => {
    const s = await setup()
    s.chest(30, 'far')
    s.chest(6, 'near')
    s.world.stock(at(30), 'torch', 100)
    s.world.stock(at(6), 'torch', 100)
    s.refresh(30)
    s.refresh(6)

    await s.supply.restock(32, skillContext().context)

    expect(s.world.inside(at(6), 'torch')).toBe(68)
    expect(s.world.inside(at(30), 'torch')).toBe(100)
  })

  it('stops before crafting when cancelled', async () => {
    const s = await setup()
    s.chest(10, 'materials')
    s.world.stock(at(10), 'coal', 2)
    s.world.stock(at(10), 'stick', 2)
    s.refresh(10)
    const { context, controller } = skillContext()
    controller.abort()

    const got = await s.supply.restock(8, context)

    expect(got.crafted).toBe(0)
    expect(s.crafted).toEqual([])
  })
})
