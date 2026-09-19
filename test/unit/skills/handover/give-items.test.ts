import { describe, expect, it } from '@jest/globals'
import { MineflayerItemFacts } from '../../../../src/bot/mineflayer-item-facts.js'
import type { Position } from '../../../../src/core/position.types.js'
import { ContainerSelector } from '../../../../src/skills/storage/container-selector.js'
import { ContainerVisitor } from '../../../../src/skills/storage/container-visitor.js'
import { DepositItemsSkill } from '../../../../src/skills/storage/deposit-items-skill.js'
import { ScanContainersSkill } from '../../../../src/skills/storage/scan-containers-skill.js'
import { WithdrawItemsSkill } from '../../../../src/skills/storage/withdraw-items-skill.js'
import { DropItemsSkill, type DropInput } from '../../../../src/skills/handover/drop-items-skill.js'
import { DropSpot } from '../../../../src/skills/handover/drop-spot.js'
import { GiveItemsSkill, type GiveInput } from '../../../../src/skills/handover/give-items-skill.js'
import type { ItemRequest } from '../../../../src/skills/handover/handover.types.js'
import { ItemThrower } from '../../../../src/skills/handover/item-thrower.js'
import { ContainerIndex } from '../../../../src/state/container-index.js'
import { StorageRules } from '../../../../src/state/storage-rules.js'
import { FakeBot } from '../../../fakes/fake-bot.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeEntityScanner } from '../../../fakes/fake-ports.js'
import { AutoScheduler, FakeDroppedItems, skillContext } from '../../../fakes/gathering-fakes.js'
import { FakeGaze, FakeInventoryWriter, playerAt } from '../../../fakes/handover-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'
import { FakeStorageWorld } from '../../../fakes/storage-fakes.js'

const facts = new MineflayerItemFacts({
  current: () => new FakeBot().useGameData(),
  onChange: () => () => undefined,
})
const at = (x: number, z = 0): Position => ({ x, y: 64, z })
const PLAYER = at(10)

async function setup() {
  const clock = new FakeClock()
  const world = new FakeStorageWorld()
  const index = new ContainerIndex(clock)
  const rules = new StorageRules()
  const store = new InMemoryStateStore()
  await index.attach(store)
  await rules.attach(store)
  const scheduler = new AutoScheduler(clock)
  const visitor = new ContainerVisitor({
    blocks: world.scanner,
    navigator: world.navigator,
    containers: world,
    index,
  })
  const shared = { inventory: world.inventory, vitals: world.vitals, index, visitor, facts }
  const withdrawer = new WithdrawItemsSkill(shared)
  const depositor = new DepositItemsSkill({
    ...shared,
    selector: new ContainerSelector(index, rules, facts),
  })
  const entities = new FakeEntityScanner()
  const gaze = new FakeGaze()
  const drops = new FakeDroppedItems()
  const writer = new FakeInventoryWriter(world, drops)
  const spot = new DropSpot(world.scanner)
  const thrower = new ItemThrower(writer, scheduler)
  playerAt(entities, 'Andrey_Knight', PLAYER)
  world.navigator.players.set('Andrey_Knight', PLAYER)
  /** The bot ends up where it walks to; when it steps away from the drop the player picks the items up. */
  const playerPicksUp = { value: true }
  world.navigator.onArrive = (target) => {
    if (world.vitals.vitals !== undefined)
      world.vitals.vitals = { ...world.vitals.vitals, position: target }
    if (playerPicksUp.value && Math.hypot(target.x - PLAYER.x, target.z - PLAYER.z) > 3)
      drops.items = []
  }
  const skill = new GiveItemsSkill({
    inventory: world.inventory,
    index,
    withdrawer,
    depositor,
    scanner: new ScanContainersSkill({ vitals: world.vitals, index, visitor }),
    navigator: world.navigator,
    entities,
    blocks: world.scanner,
    gaze,
    thrower,
    spot,
    drops,
    scheduler,
    vitals: world.vitals,
    facts,
  })
  const dropper = new DropItemsSkill({
    inventory: world.inventory,
    navigator: world.navigator,
    blocks: world.scanner,
    thrower,
    spot,
    vitals: world.vitals,
    facts,
  })
  return { clock, world, index, entities, gaze, drops, writer, skill, dropper, playerPicksUp }
}

const count = (item: string, n: number): ItemRequest => ({
  item,
  amount: { kind: 'count', count: n },
})
const give = (requests: ItemRequest[], over: Partial<GiveInput> = {}): GiveInput => ({
  player: 'Andrey_Knight',
  requests,
  fetchFromStorage: true,
  keepReserve: true,
  mode: 'drop',
  chest: undefined,
  ...over,
})

describe('GiveItemsSkill: from the inventory to a player', () => {
  it('walks to the player, faces them, throws the items, and steps back', async () => {
    const s = await setup()
    s.world.carry('iron_ingot', 20)
    const { context, progress } = skillContext()

    const result = await s.skill.run(give([count('iron_ingot', 12)]), context)

    expect(result).toEqual({
      ok: true,
      value: {
        given: [{ name: 'iron_ingot', count: 12 }],
        shortfall: [],
        mode: 'drop',
        deliveredTo: 'Andrey_Knight',
        unclaimed: [],
      },
    })
    expect(s.world.navigator.playerTrips).toEqual([{ player: 'Andrey_Knight', within: 1.5 }])
    expect(s.gaze.looked).toHaveLength(1)
    // Aimed steeply at the ground just ahead, on the line to the player (the bot stopped 1.5 blocks short of them).
    expect(s.gaze.looked[0]).toEqual({ x: 9.25, y: 64, z: 0 })
    expect(s.writer.tosses).toEqual([{ item: 'iron_ingot', count: 12 }])
    expect(s.world.have('iron_ingot')).toBe(8)
    const retreat = s.world.navigator.trips.at(-1)
    expect(
      Math.hypot((retreat?.target.x ?? 0) - PLAYER.x, (retreat?.target.z ?? 0) - PLAYER.z),
    ).toBeGreaterThan(3)
    expect(progress).toEqual(['Walking to Andrey_Knight', 'Giving 12 iron_ingot'])
  })

  it('understands words, plurals, stacks, and everything', async () => {
    const s = await setup()
    s.world.carry('cobblestone', 200)
    s.world.carry('coal', 7)
    s.world.carry('diamond', 2)

    const result = await s.skill.run(
      give([
        { item: 'cobble', amount: { kind: 'stacks', stacks: 2 } },
        { item: 'coal', amount: { kind: 'all' } },
        count('diamonds', 1),
      ]),
      skillContext().context,
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        given: [
          { name: 'cobblestone', count: 128 },
          { name: 'coal', count: 7 },
          { name: 'diamond', count: 1 },
        ],
        shortfall: [],
      },
    })
  })

  it('gives what it has and says exactly what is missing', async () => {
    const s = await setup()
    s.world.carry('iron_ingot', 5)

    const result = await s.skill.run(
      give([count('iron_ingot', 20), count('gold_ingot', 3)], { fetchFromStorage: false }),
      skillContext().context,
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        given: [{ name: 'iron_ingot', count: 5 }],
        shortfall: [
          { name: 'iron_ingot', count: 15 },
          { name: 'gold_ingot', count: 3 },
        ],
      },
    })
  })

  it('fails with the shortfall when there is nothing at all, without walking anywhere', async () => {
    const s = await setup()

    const result = await s.skill.run(give([count('iron_ingot', 20)]), skillContext().context)

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'shortfall', detail: { shortfall: [{ name: 'iron_ingot', count: 20 }] } },
    })
    expect(!result.ok && result.error.message).toContain('gather, craft, or hunt')
    expect(s.world.navigator.playerTrips).toEqual([])
  })

  it('leaves the reserve out of group requests, and gives an exactly named item', async () => {
    const s = await setup()
    s.world.carry('cooked_beef', 8)
    s.world.carry('iron_pickaxe', 1)

    const byGroup = await s.skill.run(give([count('food', 4)]), skillContext().context)
    const named = await s.skill.run(give([count('cooked_beef', 4)]), skillContext().context)
    const allowed = await s.skill.run(
      give([count('tools', 1)], { keepReserve: false }),
      skillContext().context,
    )

    expect(byGroup).toMatchObject({ ok: false, error: { reason: 'shortfall' } })
    expect(named).toMatchObject({ ok: true, value: { given: [{ name: 'cooked_beef', count: 4 }] } })
    expect(allowed).toMatchObject({
      ok: true,
      value: { given: [{ name: 'iron_pickaxe', count: 1 }] },
    }) // the reserve is off
    expect(s.world.have('iron_pickaxe')).toBe(0)
  })

  it('asks which item when the words are ambiguous, and says when it does not know the item', async () => {
    const s = await setup()
    s.world.carry('iron_ingot', 3)
    s.world.carry('raw_iron', 3)

    const iron = await s.skill.run(give([count('iron', 3)]), skillContext().context)
    const nonsense = await s.skill.run(give([count('unobtainium', 1)]), skillContext().context)

    expect(iron).toMatchObject({ ok: false, error: { reason: 'ambiguous' } })
    expect(!iron.ok && iron.error.message).toContain('Ask the player which')
    expect(nonsense).toMatchObject({ ok: false, error: { reason: 'unknown_item' } })
    expect(s.world.navigator.playerTrips).toEqual([])
  })

  it('reports what nobody picked up', async () => {
    const s = await setup()
    s.world.carry('iron_ingot', 5)
    s.playerPicksUp.value = false

    const result = await s.skill.run(give([count('iron_ingot', 5)]), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { unclaimed: [{ name: 'iron_ingot', count: 5 }] },
    })
    expect(s.clock.now()).toBeGreaterThanOrEqual(8000) // it waited for someone to pick them up
  })

  it('reports items the server would not let go of as still missing', async () => {
    const s = await setup()
    s.world.carry('iron_ingot', 10)
    s.writer.limit = 4

    const result = await s.skill.run(give([count('iron_ingot', 10)]), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: {
        given: [{ name: 'iron_ingot', count: 4 }],
        shortfall: [{ name: 'iron_ingot', count: 6 }],
      },
    })
  })
})

describe('GiveItemsSkill: fetching from chests', () => {
  async function stocked() {
    const s = await setup()
    s.world.addContainer(at(30, 5))
    s.world.addContainer(at(40, 5))
    s.index.register(at(30, 5), 'chest', { label: 'metal' })
    s.index.register(at(40, 5), 'chest', { label: 'treasure', protected: true })
    s.world.stock(at(30, 5), 'iron_ingot', 30)
    s.world.stock(at(40, 5), 'iron_ingot', 100)
    s.world.stock(at(40, 5), 'diamond', 9)
    await new (
      await import('../../../../src/skills/storage/scan-containers-skill.js')
    ).ScanContainersSkill({
      vitals: s.world.vitals,
      index: s.index,
      visitor: new ContainerVisitor({
        blocks: s.world.scanner,
        navigator: s.world.navigator,
        containers: s.world,
        index: s.index,
      }),
    }).run({ radius: 1, refreshKnown: true }, skillContext().context)
    s.world.navigator.trips.length = 0
    return s
  }

  it('takes from the inventory first, then fetches the rest from a container, then delivers', async () => {
    const s = await stocked()
    s.world.carry('iron_ingot', 5)

    const result = await s.skill.run(give([count('iron_ingot', 20)]), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { given: [{ name: 'iron_ingot', count: 20 }], shortfall: [] },
    })
    expect(s.world.inside(at(30, 5), 'iron_ingot')).toBe(15) // only 15 were fetched
    expect(s.world.have('iron_ingot')).toBe(0)
    expect(s.world.navigator.trips[0]?.target).toEqual(at(30, 5)) // the chest first, the player after
  })

  it('never fetches from a protected container, and says what is short', async () => {
    const s = await stocked()

    const result = await s.skill.run(
      give([count('iron_ingot', 50), count('diamond', 2)]),
      skillContext().context,
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        given: [{ name: 'iron_ingot', count: 30 }],
        shortfall: [
          { name: 'iron_ingot', count: 20 },
          { name: 'diamond', count: 2 },
        ],
      },
    })
    expect(s.world.inside(at(40, 5), 'iron_ingot')).toBe(100)
    expect(s.world.inside(at(40, 5), 'diamond')).toBe(9)
  })

  it('does not look in containers when told not to', async () => {
    const s = await stocked()

    const result = await s.skill.run(
      give([count('iron_ingot', 5)], { fetchFromStorage: false }),
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'shortfall' } })
    expect(s.world.opened).toEqual(['30,64,5', '40,64,5']) // only the earlier scan
  })

  it('looks into containers it has never opened when the known ones do not have enough', async () => {
    const s = await setup()
    s.world.addContainer(at(30, 5))
    s.world.addContainer(at(40, 5))
    s.index.register(at(30, 5), 'chest', { label: 'known-but-unopened' })
    s.world.stock(at(30, 5), 'iron_ingot', 4)
    s.world.stock(at(40, 5), 'iron_ingot', 10) // nobody registered this one

    const result = await s.skill.run(give([count('iron_ingot', 12)]), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { given: [{ name: 'iron_ingot', count: 12 }], shortfall: [] },
    })
    expect(s.index.at(at(40, 5))).toMatchObject({ auto: true })
  })

  it('does not scan when the known containers had enough', async () => {
    const s = await stocked()
    const opened = s.world.opened.length

    await s.skill.run(give([count('iron_ingot', 5)]), skillContext().context)

    expect(s.world.opened.length).toBe(opened + 1) // only the chest it took from
  })

  it('stops when cancelled while looking around', async () => {
    const s = await setup()
    s.world.addContainer(at(30, 5))
    s.index.register(at(30, 5), 'chest')
    s.world.navigator.failures = [{ reason: 'aborted', message: 'Cancelled.' }]

    const result = await s.skill.run(give([count('iron_ingot', 12)]), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
  })

  it('gives everything there is when asked for all, carried and stored', async () => {
    const s = await stocked()
    s.world.carry('iron_ingot', 5)

    const result = await s.skill.run(
      give([{ item: 'iron_ingot', amount: { kind: 'all' } }]),
      skillContext().context,
    )

    expect(result).toMatchObject({
      ok: true,
      value: { given: [{ name: 'iron_ingot', count: 35 }] },
    })
  })

  it('understands a group across chests', async () => {
    const s = await stocked()
    s.world.stock(at(30, 5), 'raw_gold', 4)
    await s.world.open(at(30, 5)) // (a visit refreshes the index)
    s.index.recordContents(
      'container-1',
      [
        { name: 'iron_ingot', count: 30 },
        { name: 'raw_gold', count: 4 },
      ],
      { totalSlots: 27, emptySlots: 25 },
    )

    const result = await s.skill.run(give([count('ores', 4)]), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { given: [{ name: 'raw_gold', count: 4 }] } })
  })

  it('stops when cancelled while fetching', async () => {
    const s = await stocked()
    s.world.navigator.failures = [{ reason: 'aborted', message: 'Cancelled.' }]

    const result = await s.skill.run(give([count('iron_ingot', 5)]), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
  })
})

describe('GiveItemsSkill: reaching the player', () => {
  it('fails when the player is offline or out of view', async () => {
    const s = await setup()
    s.world.carry('dirt', 5)
    s.entities.players.clear()
    const offline = await s.skill.run(give([count('dirt', 5)]), skillContext().context)
    s.entities.players.set('andrey_knight', {
      name: 'Andrey_Knight',
      online: true,
      position: undefined,
      distance: undefined,
    })
    const hidden = await s.skill.run(give([count('dirt', 5)]), skillContext().context)

    expect(offline).toMatchObject({ ok: false, error: { reason: 'player_not_online' } })
    expect(hidden).toMatchObject({ ok: false, error: { reason: 'player_not_visible' } })
    expect(!hidden.ok && hidden.error.message).toContain('another dimension')
    expect(s.world.have('dirt')).toBe(5)
  })

  it('fails when the way to the player is blocked, is lost, or is cancelled', async () => {
    const s = await setup()
    s.world.carry('dirt', 5)

    s.world.navigator.playerFailures = [{ reason: 'unreachable', message: 'No path' }]
    const blocked = await s.skill.run(give([count('dirt', 5)]), skillContext().context)
    s.world.navigator.playerFailures = [{ reason: 'target_not_found', message: 'gone' }]
    const lost = await s.skill.run(give([count('dirt', 5)]), skillContext().context)
    s.world.navigator.playerFailures = [{ reason: 'aborted', message: 'Cancelled.' }]
    const cancelled = await s.skill.run(give([count('dirt', 5)]), skillContext().context)

    expect(blocked).toMatchObject({ ok: false, error: { reason: 'unreachable' } })
    expect(lost).toMatchObject({ ok: false, error: { reason: 'player_not_visible' } })
    expect(cancelled).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(s.world.have('dirt')).toBe(5)
  })

  it('refuses to drop on a ledge or in lava', async () => {
    const s = await setup()
    s.world.carry('dirt', 5)
    s.world.navigator.onArrive = (target) => {
      s.world.vitals.vitals = {
        ...(s.world.vitals.vitals as NonNullable<typeof s.world.vitals.vitals>),
        position: target,
      }
    }
    s.world.scanner.solid.set('8,63,0', false)

    const ledge = await s.skill.run(give([count('dirt', 5)]), skillContext().context)
    s.world.scanner.solid.set('8,63,0', true)
    s.world.scanner.blockNames.set('8,63,0', 'lava')
    const lava = await s.skill.run(give([count('dirt', 5)]), skillContext().context)

    expect(ledge).toMatchObject({ ok: false, error: { reason: 'unsafe_drop_spot' } })
    expect(lava).toMatchObject({ ok: false, error: { reason: 'unsafe_drop_spot' } })
    expect(s.writer.tosses).toEqual([])
  })

  it('tries other directions to step back, and stops once cancelled', async () => {
    const s = await setup()
    s.world.carry('dirt', 5)
    s.world.navigator.failures = [{ reason: 'unreachable', message: 'wall' }, undefined]

    const result = await s.skill.run(give([count('dirt', 5)]), skillContext().context)

    expect(result.ok).toBe(true)
    expect(s.world.navigator.trips.length).toBeGreaterThanOrEqual(2)
  })

  it('reports not being connected', async () => {
    const s = await setup()
    s.world.inventory.value = undefined

    expect(await s.skill.run(give([count('dirt', 5)]), skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'not_connected' },
    })
  })
})

describe('GiveItemsSkill: chest mode', () => {
  it('puts the items in the named chest and says where', async () => {
    const s = await setup()
    s.world.addContainer(at(20, 4))
    s.index.register(at(20, 4), 'chest', { label: 'for-andrey' })
    s.world.carry('cobblestone', 300)

    const result = await s.skill.run(
      give([count('cobblestone', 200)], { mode: 'chest', chest: 'for-andrey' }),
      skillContext().context,
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        mode: 'chest',
        given: [{ name: 'cobblestone', count: 200 }],
        deliveredTo: expect.stringContaining('"for-andrey" at 20, 64, 4') as unknown as string,
      },
    })
    expect(s.world.inside(at(20, 4), 'cobblestone')).toBe(200)
    expect(s.world.have('cobblestone')).toBe(100)
    expect(s.world.navigator.playerTrips).toEqual([])
  })

  it('uses any chest with room when none is named, and reports when it cannot', async () => {
    const s = await setup()
    s.world.carry('cobblestone', 10)
    const none = await s.skill.run(
      give([count('cobblestone', 10)], { mode: 'chest' }),
      skillContext().context,
    )
    s.world.addContainer(at(20, 4))

    const found = await s.skill.run(
      give([count('cobblestone', 10)], { mode: 'chest' }),
      skillContext().context,
    )

    expect(none).toMatchObject({ ok: false, error: { reason: 'no_storage_space' } })
    expect(found).toMatchObject({
      ok: true,
      value: { given: [{ name: 'cobblestone', count: 10 }] },
    })
  })

  it('keeps going when one item does not fit, and reports it', async () => {
    const s = await setup()
    s.world.addContainer(at(20, 4), 'chest', 2)
    s.index.register(at(20, 4), 'chest', { label: 'small' })
    s.world.stock(at(20, 4), 'dirt', 10)
    s.world.carry('cobblestone', 10)
    s.world.carry('gravel', 10)

    const result = await s.skill.run(
      give([count('cobblestone', 10), count('gravel', 10)], { mode: 'chest', chest: 'small' }),
      skillContext().context,
    )

    expect(result).toMatchObject({
      ok: true,
      value: { given: [{ name: 'cobblestone', count: 10 }] },
    })
    expect(result.ok && result.value.shortfall).toEqual([{ name: 'gravel', count: 10 }])
  })

  it('stops when cancelled', async () => {
    const s = await setup()
    s.world.addContainer(at(20, 4))
    s.world.navigator.failures = [{ reason: 'aborted', message: 'Cancelled.' }]
    s.world.carry('cobblestone', 10)

    expect(
      await s.skill.run(
        give([count('cobblestone', 10)], { mode: 'chest' }),
        skillContext().context,
      ),
    ).toMatchObject({ ok: false, error: { reason: 'aborted' } })
  })
})

describe('DropItemsSkill', () => {
  const drop = (requests: ItemRequest[], keepReserve = true): DropInput => ({
    requests,
    keepReserve,
  })

  it('throws items on the ground where it stands and steps away', async () => {
    const s = await setup()
    s.world.carry('dirt', 20)
    s.world.carry('cobblestone', 5)

    const result = await s.dropper.run(
      drop([count('dirt', 15), { item: 'cobble', amount: { kind: 'all' } }]),
      skillContext().context,
    )

    expect(result).toEqual({
      ok: true,
      value: {
        dropped: [
          { name: 'dirt', count: 15 },
          { name: 'cobblestone', count: 5 },
        ],
        notCarried: [],
      },
    })
    expect(s.world.have('dirt')).toBe(5)
    expect(s.world.navigator.trips).toHaveLength(1)
    expect(s.world.navigator.trips[0]?.target.x).toBe(4)
  })

  it('says what it does not carry, and refuses when there is nothing to drop', async () => {
    const s = await setup()
    s.world.carry('dirt', 2)

    const partial = await s.dropper.run(drop([count('dirt', 5)]), skillContext().context)
    const none = await s.dropper.run(drop([count('diamond', 1)]), skillContext().context)

    expect(partial).toMatchObject({
      ok: true,
      value: { dropped: [{ name: 'dirt', count: 2 }], notCarried: [{ name: 'dirt', count: 3 }] },
    })
    expect(none).toMatchObject({ ok: false, error: { reason: 'nothing_to_drop' } })
  })

  it('keeps the reserve out of group requests', async () => {
    const s = await setup()
    s.world.carry('cooked_beef', 8)

    const byGroup = await s.dropper.run(drop([count('food', 8)]), skillContext().context)
    const named = await s.dropper.run(drop([count('cooked_beef', 8)]), skillContext().context)

    expect(byGroup).toMatchObject({ ok: false, error: { reason: 'nothing_to_drop' } })
    expect(named).toMatchObject({
      ok: true,
      value: { dropped: [{ name: 'cooked_beef', count: 8 }] },
    })
  })

  it('refuses ambiguous words, unsafe spots, and being offline', async () => {
    const s = await setup()
    s.world.carry('iron_ingot', 3)
    s.world.carry('raw_iron', 3)

    const ambiguous = await s.dropper.run(drop([count('iron', 3)]), skillContext().context)
    s.world.scanner.blockNames.set('0,63,0', 'lava')
    const unsafe = await s.dropper.run(drop([count('raw_iron', 3)]), skillContext().context)
    s.world.inventory.value = undefined
    const offline = await s.dropper.run(drop([count('raw_iron', 3)]), skillContext().context)

    expect(ambiguous).toMatchObject({ ok: false, error: { reason: 'ambiguous' } })
    expect(unsafe).toMatchObject({ ok: false, error: { reason: 'unsafe_drop_spot' } })
    expect(offline).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
  })
})
