import { describe, expect, it } from '@jest/globals'
import { MineflayerItemFacts } from '../../../../src/bot/mineflayer-item-facts.js'
import { ContainerSelector } from '../../../../src/skills/storage/container-selector.js'
import { ContainerVisitor } from '../../../../src/skills/storage/container-visitor.js'
import {
  DepositItemsSkill,
  type DepositInput,
} from '../../../../src/skills/storage/deposit-items-skill.js'
import { FindItemsSkill } from '../../../../src/skills/storage/find-items-skill.js'
import { ScanContainersSkill } from '../../../../src/skills/storage/scan-containers-skill.js'
import { WithdrawItemsSkill } from '../../../../src/skills/storage/withdraw-items-skill.js'
import { ContainerIndex } from '../../../../src/state/container-index.js'
import { StorageRules } from '../../../../src/state/storage-rules.js'
import { FakeBot } from '../../../fakes/fake-bot.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { skillContext } from '../../../fakes/gathering-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'
import { FakeStorageWorld } from '../../../fakes/storage-fakes.js'

const facts = new MineflayerItemFacts({
  current: () => new FakeBot().useGameData(),
  onChange: () => () => undefined,
})
const at = (x: number, z = 0) => ({ x, y: 64, z })

async function setup() {
  const world = new FakeStorageWorld()
  const index = new ContainerIndex(new FakeClock())
  const rules = new StorageRules()
  const store = new InMemoryStateStore()
  await index.attach(store)
  await rules.attach(store)
  const visitor = new ContainerVisitor({
    blocks: world.scanner,
    navigator: world.navigator,
    containers: world,
    index,
  })
  const selector = new ContainerSelector(index, rules, facts)
  const deps = { inventory: world.inventory, vitals: world.vitals, index, visitor, facts }
  return {
    world,
    index,
    rules,
    visitor,
    deposit: new DepositItemsSkill({ ...deps, selector }),
    withdraw: new WithdrawItemsSkill(deps),
    scan: new ScanContainersSkill({ vitals: world.vitals, index, visitor }),
    find: (scanIfMissing = true) =>
      new FindItemsSkill({
        index,
        scanner: new ScanContainersSkill({ vitals: world.vitals, index, visitor }),
        facts,
      }).run({ query: 'iron_ingot', scanIfMissing, radius: 24 }, skillContext().context),
  }
}

const dep = (over: Partial<DepositInput> = {}): DepositInput => ({
  specs: undefined,
  includeReserved: false,
  container: undefined,
  count: undefined,
  maxDistance: 64,
  ...over,
})

describe('DepositItemsSkill', () => {
  it('sends each kind of item where the rules say, and leaves the gear alone', async () => {
    const s = await setup()
    for (const [x, label] of [
      [10, 'stone'],
      [20, 'metal'],
      [30, 'misc'],
    ] as const) {
      s.world.addContainer(at(x))
      s.index.register(at(x), 'chest', { label })
    }
    s.rules.add('container-1', ['stone', 'cobblestone'])
    s.rules.add('container-2', ['ores', 'ingots'])
    s.rules.add('container-3', ['*'], -10)
    for (const [item, n] of [
      ['cobblestone', 100],
      ['raw_iron', 12],
      ['iron_ingot', 3],
      ['feather', 5],
      ['iron_pickaxe', 1],
      ['cooked_beef', 8],
      ['torch', 16],
    ] as const)
      s.world.carry(item, n)

    const result = await s.deposit.run(dep(), skillContext().context)

    expect(s.world.inside(at(10), 'cobblestone')).toBe(100)
    expect(s.world.inside(at(20), 'raw_iron')).toBe(12)
    expect(s.world.inside(at(20), 'iron_ingot')).toBe(3)
    expect(s.world.inside(at(30), 'feather')).toBe(5)
    expect(s.world.have('iron_pickaxe')).toBe(1)
    expect(s.world.have('cooked_beef')).toBe(8)
    expect(s.world.have('torch')).toBe(16)
    expect(result).toMatchObject({ ok: true, value: { leftover: [] } })
    expect(result.ok && result.value.deposited.map((d) => d.label).sort()).toEqual([
      'metal',
      'misc',
      'stone',
    ])
    expect(s.index.get('container-2')?.contents).toEqual(
      expect.arrayContaining([{ name: 'raw_iron', count: 12 }]),
    )
  })

  it('walks to each container, nearest first', async () => {
    const s = await setup()
    s.world.addContainer(at(30))
    s.world.addContainer(at(10))
    s.index.register(at(30), 'chest')
    s.index.register(at(10), 'chest')
    s.rules.add('container-1', ['dirt'])
    s.rules.add('container-2', ['sand'])
    s.world.carry('dirt', 5)
    s.world.carry('sand', 5)

    await s.deposit.run(dep(), skillContext().context)

    expect(s.world.navigator.trips.map((t) => t.target.x)).toEqual([10, 30])
    expect(s.world.navigator.trips[0]?.within).toBe(2.5)
  })

  it('deposits reserved items when they are named exactly, or when told to', async () => {
    const s = await setup()
    s.world.addContainer(at(10))
    s.index.register(at(10), 'chest')
    s.world.carry('cooked_beef', 8)
    s.world.carry('iron_pickaxe', 1)
    s.world.carry('dirt', 4)

    await s.deposit.run(dep({ specs: ['cooked_beef'] }), skillContext().context)
    expect(s.world.inside(at(10), 'cooked_beef')).toBe(8)
    expect(s.world.have('dirt')).toBe(4)

    await s.deposit.run(dep({ specs: ['tools'] }), skillContext().context)
    expect(s.world.have('iron_pickaxe')).toBe(1) // the group "tools" does not name the pickaxe exactly

    await s.deposit.run(dep({ includeReserved: true }), skillContext().context)
    expect(s.world.have('iron_pickaxe')).toBe(0)
    expect(s.world.have('dirt')).toBe(0)
  })

  it('takes only the wanted number of a single item', async () => {
    const s = await setup()
    s.world.addContainer(at(10))
    s.index.register(at(10), 'chest')
    s.world.carry('cobblestone', 100)

    await s.deposit.run(dep({ specs: ['cobblestone'], count: 30 }), skillContext().context)

    expect(s.world.inside(at(10), 'cobblestone')).toBe(30)
    expect(s.world.have('cobblestone')).toBe(70)
  })

  it('puts everything into the named container, ignoring the rules', async () => {
    const s = await setup()
    s.world.addContainer(at(10))
    s.world.addContainer(at(20))
    s.index.register(at(10), 'chest', { label: 'home' })
    s.index.register(at(20), 'chest')
    s.rules.add('container-2', ['dirt'])
    s.world.carry('dirt', 5)

    const result = await s.deposit.run(dep({ container: 'home' }), skillContext().context)

    expect(result.ok).toBe(true)
    expect(s.world.inside(at(10), 'dirt')).toBe(5)
    expect(s.world.inside(at(20), 'dirt')).toBe(0)
  })

  it('refuses an unknown or protected container', async () => {
    const s = await setup()
    s.world.addContainer(at(10))
    s.index.register(at(10), 'chest', { label: 'mine', protected: true })
    s.world.carry('dirt', 5)

    const unknown = await s.deposit.run(dep({ container: 'nowhere' }), skillContext().context)
    const guarded = await s.deposit.run(dep({ container: 'mine' }), skillContext().context)

    expect(unknown).toMatchObject({ ok: false, error: { reason: 'unknown_container' } })
    expect(guarded).toMatchObject({ ok: false, error: { reason: 'protected' } })
    expect(s.world.have('dirt')).toBe(5)
  })

  it('spills over into the next container when one is full, and reports what did not fit', async () => {
    const s = await setup()
    s.world.addContainer(at(10), 'chest', 1) // room for one stack
    s.world.addContainer(at(20), 'chest', 1)
    s.index.register(at(10), 'chest')
    s.index.register(at(20), 'chest')
    s.world.carry('dirt', 150)

    const result = await s.deposit.run(dep(), skillContext().context)

    expect(s.world.inside(at(10), 'dirt')).toBe(64)
    expect(s.world.inside(at(20), 'dirt')).toBe(64)
    expect(result).toMatchObject({ ok: true, value: { leftover: [{ name: 'dirt', count: 22 }] } })
  })

  it('fails with no_storage_space when nothing could be put anywhere', async () => {
    const s = await setup()
    s.world.carry('dirt', 5)

    const none = await s.deposit.run(dep(), skillContext().context)
    s.world.addContainer(at(10), 'chest', 1)
    s.index.register(at(10), 'chest')
    s.world.stock(at(10), 'stone', 64)
    const full = await s.deposit.run(dep(), skillContext().context)

    expect(none).toMatchObject({
      ok: false,
      error: { reason: 'no_storage_space', detail: { leftover: [{ name: 'dirt', count: 5 }] } },
    })
    expect(full).toMatchObject({ ok: false, error: { reason: 'no_storage_space' } })
    expect(s.world.have('dirt')).toBe(5)
  })

  it('uses a chest nobody registered, and registers it', async () => {
    const s = await setup()
    s.world.addContainer(at(12), 'barrel')
    s.world.carry('dirt', 5)

    const result = await s.deposit.run(dep(), skillContext().context)

    expect(result.ok).toBe(true)
    expect(s.world.inside(at(12), 'dirt')).toBe(5)
    expect(s.index.at(at(12))).toMatchObject({ id: 'container-1', blockName: 'barrel', auto: true })
  })

  it('never uses a protected container, even a nearby one', async () => {
    const s = await setup()
    s.world.addContainer(at(5))
    s.index.register(at(5), 'chest', { protected: true })
    s.world.carry('dirt', 5)

    const result = await s.deposit.run(dep(), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_storage_space' } })
    expect(s.world.opened).toEqual([])
  })

  it('forgets a container that has been broken and uses another', async () => {
    const s = await setup()
    s.world.addContainer(at(10))
    s.world.addContainer(at(20))
    s.index.register(at(10), 'chest')
    s.index.register(at(20), 'chest')
    s.world.breakContainer(at(10))
    s.world.carry('dirt', 5)

    const result = await s.deposit.run(dep(), skillContext().context)

    expect(result.ok).toBe(true)
    expect(s.index.get('container-1')).toBeUndefined()
    expect(s.world.inside(at(20), 'dirt')).toBe(5)
  })

  it('skips a container that cannot be reached or opened', async () => {
    const s = await setup()
    s.world.addContainer(at(10))
    s.world.addContainer(at(20))
    s.index.register(at(10), 'chest')
    s.index.register(at(20), 'chest')
    s.world.navigator.failures = [{ reason: 'unreachable', message: 'No path' }]
    s.world.carry('dirt', 5)

    const result = await s.deposit.run(dep(), skillContext().context)

    expect(result.ok).toBe(true)
    expect(s.world.inside(at(20), 'dirt')).toBe(5)

    s.world.openFailure = 'too far'
    s.world.carry('sand', 5)
    const failed = await s.deposit.run(dep(), skillContext().context)
    expect(failed).toMatchObject({ ok: false, error: { reason: 'no_storage_space' } })
    expect(!failed.ok && failed.error.message).toContain('too far')
  })

  it('reports nothing to deposit, and not being connected', async () => {
    const s = await setup()
    s.world.addContainer(at(10))
    s.world.carry('iron_pickaxe', 1)

    const gear = await s.deposit.run(dep(), skillContext().context)
    const none = await s.deposit.run(dep({ specs: ['dirt'] }), skillContext().context)
    s.world.inventory.value = undefined
    const offline = await s.deposit.run(dep(), skillContext().context)
    s.world.inventory.value = {
      stacks: [{ name: 'dirt', count: 1 }],
      emptySlots: 5,
      heldItem: undefined,
    }
    s.world.vitals.vitals = undefined
    const noPosition = await s.deposit.run(dep(), skillContext().context)

    expect(gear).toMatchObject({ ok: false, error: { reason: 'nothing_to_deposit' } })
    expect(!none.ok && none.error.message).toBe('The bot carries none of dirt.')
    expect(offline).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
    expect(noPosition).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
  })

  it('stops when cancelled, also while walking', async () => {
    const s = await setup()
    s.world.addContainer(at(10))
    s.index.register(at(10), 'chest')
    s.world.carry('dirt', 5)
    const { context, controller } = skillContext()
    controller.abort()

    const before = await s.deposit.run(dep(), context)
    s.world.navigator.failures = [{ reason: 'aborted', message: 'Cancelled.' }]
    const walking = await s.deposit.run(dep(), skillContext().context)

    expect(before).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(walking).toMatchObject({ ok: false, error: { reason: 'aborted' } })
  })
})

describe('WithdrawItemsSkill', () => {
  const ingots = async () => {
    const s = await setup()
    s.world.addContainer(at(30))
    s.world.addContainer(at(10))
    s.index.register(at(30), 'chest', { label: 'far' })
    s.index.register(at(10), 'chest', { label: 'near' })
    s.world.stock(at(30), 'iron_ingot', 20)
    s.world.stock(at(10), 'iron_ingot', 5)
    await s.scan.run({ radius: 1, refreshKnown: true }, skillContext().context)
    s.world.navigator.trips.length = 0
    return s
  }
  const req = (item: string, count?: number) => ({
    requests: [{ item, count }],
    container: undefined,
  })

  it('takes items from the nearest containers first, until it has enough', async () => {
    const s = await ingots()

    const result = await s.withdraw.run(req('iron_ingot', 12), skillContext().context)

    expect(result).toEqual({
      ok: true,
      value: { withdrawn: [{ name: 'iron_ingot', count: 12 }], shortfall: [] },
    })
    expect(s.world.navigator.trips.map((t) => t.target.x)).toEqual([10, 30])
    expect(s.world.inside(at(10), 'iron_ingot')).toBe(0)
    expect(s.world.inside(at(30), 'iron_ingot')).toBe(13)
    expect(s.index.get('container-2')?.contents).toEqual([])
  })

  it('takes everything found when no count is given, and reports what is missing when a count is not met', async () => {
    const s = await ingots()

    const all = await s.withdraw.run(req('iron_ingot'), skillContext().context)
    const short = await s.withdraw.run(req('iron_ingot', 10), skillContext().context)

    expect(all).toMatchObject({
      ok: true,
      value: { withdrawn: [{ name: 'iron_ingot', count: 25 }], shortfall: [] },
    })
    expect(short).toMatchObject({ ok: false, error: { reason: 'not_found' } })
  })

  it('reports a shortfall alongside what it did get', async () => {
    const s = await ingots()

    const result = await s.withdraw.run(req('iron_ingot', 40), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: {
        withdrawn: [{ name: 'iron_ingot', count: 25 }],
        shortfall: [{ name: 'iron_ingot', count: 15 }],
      },
    })
  })

  it('takes every known item of a group', async () => {
    const s = await ingots()
    s.world.stock(at(10), 'raw_gold', 3)
    s.world.stock(at(10), 'dirt', 9)
    await s.scan.run({ radius: 1, refreshKnown: true }, skillContext().context)

    const result = await s.withdraw.run(req('ores'), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { withdrawn: [{ name: 'raw_gold', count: 3 }] },
    })
    expect(s.world.have('dirt')).toBe(0)
  })

  it('reads what the container really holds, not what the index remembers', async () => {
    const s = await ingots()
    s.world.stock(at(10), 'iron_ingot', 7) // the player added some since the last scan

    const result = await s.withdraw.run(req('iron_ingot', 12), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { withdrawn: [{ name: 'iron_ingot', count: 12 }] },
    })
    expect(s.world.inside(at(10), 'iron_ingot')).toBe(0)
  })

  it('never takes from a protected container, and refuses when it is named', async () => {
    const s = await ingots()
    s.index.amend('container-2', { protected: true })

    const anywhere = await s.withdraw.run(req('iron_ingot', 25), skillContext().context)
    const named = await s.withdraw.run(
      { requests: [{ item: 'iron_ingot', count: 1 }], container: 'near' },
      skillContext().context,
    )

    expect(anywhere).toMatchObject({
      ok: true,
      value: {
        withdrawn: [{ name: 'iron_ingot', count: 20 }],
        shortfall: [{ name: 'iron_ingot', count: 5 }],
      },
    })
    expect(s.world.inside(at(10), 'iron_ingot')).toBe(5)
    expect(named).toMatchObject({ ok: false, error: { reason: 'protected' } })
  })

  it('takes only from the named container', async () => {
    const s = await ingots()

    const result = await s.withdraw.run(
      { requests: [{ item: 'iron_ingot', count: 3 }], container: 'far' },
      skillContext().context,
    )
    const unknown = await s.withdraw.run(
      { requests: [{ item: 'iron_ingot', count: 3 }], container: 'none' },
      skillContext().context,
    )

    expect(result.ok).toBe(true)
    expect(s.world.inside(at(30), 'iron_ingot')).toBe(17)
    expect(unknown).toMatchObject({ ok: false, error: { reason: 'unknown_container' } })
  })

  it('says where it looked when the item is nowhere', async () => {
    const s = await ingots()

    const result = await s.withdraw.run(req('diamond', 1), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'not_found' } })
    expect(!result.ok && result.error.message).toContain('scan_containers')
  })

  it('stops when the inventory has no room', async () => {
    const s = await ingots()
    s.world.playerSlots = 0
    s.world.sync()

    const result = await s.withdraw.run(req('iron_ingot', 5), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'inventory_full' } })
    expect(s.world.inside(at(10), 'iron_ingot')).toBe(5)
  })

  it('goes on to the next container when one is gone, and stops when cancelled', async () => {
    const s = await ingots()
    s.world.breakContainer(at(10))

    const result = await s.withdraw.run(req('iron_ingot', 5), skillContext().context)
    const { context, controller } = skillContext()
    controller.abort()
    const cancelled = await s.withdraw.run(req('iron_ingot', 5), context)
    s.world.navigator.failures = [{ reason: 'aborted', message: 'Cancelled.' }]
    const walking = await s.withdraw.run(req('iron_ingot', 5), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { withdrawn: [{ name: 'iron_ingot', count: 5 }] },
    })
    expect(s.index.get('container-2')).toBeUndefined()
    expect(cancelled).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(walking).toMatchObject({ ok: false, error: { reason: 'aborted' } })
  })
})

describe('ScanContainersSkill and FindItemsSkill', () => {
  it('registers containers it finds, opens them nearest first, and records what is inside', async () => {
    const s = await setup()
    s.world.addContainer(at(20))
    s.world.addContainer(at(8), 'barrel')
    s.world.stock(at(20), 'iron_ingot', 4)
    s.world.stock(at(8), 'coal', 9)

    const result = await s.scan.run({ radius: 24, refreshKnown: true }, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { scanned: 2, discovered: 2, missing: 0 } })
    expect(s.world.opened).toEqual(['8,64,0', '20,64,0'])
    expect(s.index.at(at(8))).toMatchObject({
      blockName: 'barrel',
      auto: true,
      contents: [{ name: 'coal', count: 9 }],
    })
  })

  it('forgets containers that are gone, and can skip the known ones', async () => {
    const s = await setup()
    s.world.addContainer(at(20))
    s.index.register(at(20), 'chest')
    s.world.addContainer(at(10))
    s.index.register(at(10), 'chest')
    s.world.breakContainer(at(20))

    const skipped = await s.scan.run({ radius: 24, refreshKnown: false }, skillContext().context)
    const result = await s.scan.run({ radius: 24, refreshKnown: true }, skillContext().context)

    expect(skipped).toMatchObject({ ok: true, value: { scanned: 0 } })
    expect(result).toMatchObject({ ok: true, value: { scanned: 1, missing: 1 } })
    expect(s.index.at(at(20))).toBeUndefined()
  })

  it('reports progress, and stops when cancelled or not connected', async () => {
    const s = await setup()
    s.world.addContainer(at(10))
    const { context, progress } = skillContext()

    await s.scan.run({ radius: 24, refreshKnown: true }, context)
    s.world.navigator.failures = [{ reason: 'aborted', message: 'Cancelled.' }]
    s.index.register(at(10), 'chest')
    const walking = await s.scan.run({ radius: 24, refreshKnown: true }, skillContext().context)
    s.world.vitals.vitals = undefined
    const offline = await s.scan.run({ radius: 24, refreshKnown: true }, skillContext().context)

    expect(progress[0]).toContain('Looking into')
    expect(walking).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(offline).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
  })

  it('finds an item from memory without opening anything', async () => {
    const s = await setup()
    s.world.addContainer(at(10))
    s.index.register(at(10), 'chest', { label: 'metal' })
    s.world.stock(at(10), 'iron_ingot', 4)
    await s.scan.run({ radius: 1, refreshKnown: true }, skillContext().context)
    s.world.opened.length = 0

    const result = await s.find()

    expect(result).toMatchObject({
      ok: true,
      value: {
        matches: [
          {
            container: 'container-1',
            label: 'metal',
            items: [{ name: 'iron_ingot', count: 4 }],
            protected: false,
          },
        ],
        total: 4,
        scanned: false,
      },
    })
    expect(s.world.opened).toEqual([])
  })

  it('looks into the containers when memory has nothing, and only then', async () => {
    const s = await setup()
    s.world.addContainer(at(10))
    s.world.stock(at(10), 'iron_ingot', 4)

    const noScan = await s.find(false)
    const withScan = await s.find(true)

    expect(noScan).toMatchObject({ ok: true, value: { matches: [], total: 0, scanned: false } })
    expect(withScan).toMatchObject({ ok: true, value: { total: 4, scanned: true } })
  })

  it('shows protected containers as protected, and passes on a failed scan', async () => {
    const s = await setup()
    s.world.addContainer(at(10))
    s.index.register(at(10), 'chest', { protected: true })
    s.world.stock(at(10), 'iron_ingot', 4)
    await s.scan.run({ radius: 1, refreshKnown: true }, skillContext().context)

    const shown = await s.find()
    s.index.remove('container-1')
    s.world.vitals.vitals = undefined
    const failed = await s.find()

    expect(shown).toMatchObject({ ok: true, value: { matches: [{ protected: true }] } })
    expect(failed).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
  })
})
