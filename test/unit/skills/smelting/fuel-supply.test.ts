import { describe, expect, it } from '@jest/globals'
import { MineflayerItemFacts } from '../../../../src/bot/mineflayer-item-facts.js'
import { FuelSupply } from '../../../../src/skills/smelting/fuel-supply.js'
import { ContainerVisitor } from '../../../../src/skills/storage/container-visitor.js'
import { ScanContainersSkill } from '../../../../src/skills/storage/scan-containers-skill.js'
import { WithdrawItemsSkill } from '../../../../src/skills/storage/withdraw-items-skill.js'
import { ContainerIndex } from '../../../../src/state/container-index.js'
import { FakeBot } from '../../../fakes/fake-bot.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { skillContext } from '../../../fakes/gathering-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'
import { FakeStorageWorld } from '../../../fakes/storage-fakes.js'

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
  const scanner = new ScanContainersSkill({ vitals: world.vitals, index, visitor })
  const supply = new FuelSupply({ inventory: world.inventory, withdraw, scanner })
  const blind = new FuelSupply({ inventory: world.inventory, withdraw })
  const chest = (x: number, label: string, guarded = false): void => {
    world.addContainer(at(x))
    index.register(at(x), 'chest', { label, protected: guarded })
  }
  /** Lets the index remember what a container holds, as after a scan. */
  const refresh = (x: number): void => {
    const entry = index.at(at(x))
    const container = world.containers.get(`${String(x)},64,0`)
    if (entry === undefined) throw new Error('no such container')
    index.recordContents(
      entry.id,
      [...(container?.stacks ?? [])].map(([name, count]) => ({ name, count })),
      { totalSlots: 27, emptySlots: 27 },
    )
  }
  return { world, supply, blind, chest, refresh }
}

describe('FuelSupply', () => {
  it('takes just as much coal as the missing items need (one coal smelts eight)', async () => {
    const s = await setup()
    s.chest(10, 'fuel')
    s.world.stock(at(10), 'coal', 20)
    s.refresh(10)

    const got = await s.supply.fetch(20, undefined, skillContext().context)

    expect(got).toEqual([{ name: 'coal', count: 3 }]) // 3 x 8 = 24 >= 20
    expect(s.world.inside(at(10), 'coal')).toBe(17)
  })

  it('takes half as much for a blast furnace or a smoker, which stretch the fuel twice as far', async () => {
    const s = await setup()
    s.chest(10, 'fuel')
    s.world.stock(at(10), 'coal', 20)
    s.refresh(10)

    const got = await s.supply.fetch(32, undefined, skillContext().context, 2)

    expect(got).toEqual([{ name: 'coal', count: 2 }]) // 2 x 16 = 32
  })

  it('takes charcoal before coal', async () => {
    const s = await setup()
    s.chest(10, 'fuel')
    s.world.stock(at(10), 'charcoal', 5)
    s.world.stock(at(10), 'coal', 5)
    s.refresh(10)

    const got = await s.supply.fetch(16, undefined, skillContext().context)

    expect(got).toEqual([{ name: 'charcoal', count: 2 }])
    expect(s.world.inside(at(10), 'coal')).toBe(5)
  })

  it('makes up what charcoal cannot cover with coal', async () => {
    const s = await setup()
    s.chest(10, 'fuel')
    s.world.stock(at(10), 'charcoal', 1)
    s.world.stock(at(10), 'coal', 5)
    s.refresh(10)

    const got = await s.supply.fetch(20, undefined, skillContext().context)

    expect(got).toEqual(
      expect.arrayContaining([
        { name: 'charcoal', count: 1 },
        { name: 'coal', count: 2 },
      ]),
    )
  })

  it('takes only the fuel that is named when one is', async () => {
    const s = await setup()
    s.chest(10, 'fuel')
    s.world.stock(at(10), 'coal', 5)
    s.world.stock(at(10), 'oak_planks', 20)
    s.refresh(10)

    const got = await s.supply.fetch(6, 'oak_planks', skillContext().context)

    expect(got).toEqual([{ name: 'oak_planks', count: 4 }])
    expect(s.world.inside(at(10), 'coal')).toBe(5)
  })

  it('never takes coal blocks, blaze rods, or lava buckets by itself', async () => {
    const s = await setup()
    s.chest(10, 'fuel')
    s.world.stock(at(10), 'coal_block', 5)
    s.world.stock(at(10), 'blaze_rod', 5)
    s.refresh(10)

    const got = await s.supply.fetch(50, undefined, skillContext().context)

    expect(got).toEqual([])
  })

  it('looks into a chest that was registered but never opened, once', async () => {
    const s = await setup()
    s.chest(10, 'fuel')
    s.world.stock(at(10), 'coal', 10)

    const got = await s.supply.fetch(8, undefined, skillContext().context)

    expect(got).toEqual([{ name: 'coal', count: 1 }])
  })

  it('does not use an unopened chest without a scanner', async () => {
    const s = await setup()
    s.chest(10, 'fuel')
    s.world.stock(at(10), 'coal', 10)

    const got = await s.blind.fetch(8, undefined, skillContext().context)

    expect(got).toEqual([])
  })

  it('never opens a protected container', async () => {
    const s = await setup()
    s.chest(10, 'treasure', true)
    s.world.stock(at(10), 'coal', 10)
    s.refresh(10)

    const got = await s.supply.fetch(8, undefined, skillContext().context)

    expect(got).toEqual([])
    expect(s.world.opened).toEqual([])
  })

  it('gets nothing when no container holds fuel', async () => {
    const s = await setup()
    s.chest(10, 'junk')
    s.world.stock(at(10), 'cobblestone', 30)
    s.refresh(10)

    expect(await s.supply.fetch(8, undefined, skillContext().context)).toEqual([])
  })

  it('does nothing when cancelled', async () => {
    const s = await setup()
    s.chest(10, 'fuel')
    s.world.stock(at(10), 'coal', 10)
    s.refresh(10)
    const { context, controller } = skillContext()
    controller.abort()

    expect(await s.supply.fetch(8, undefined, context)).toEqual([])
    expect(s.world.opened).toEqual([])
  })
})
