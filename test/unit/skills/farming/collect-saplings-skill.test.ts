import { describe, expect, it } from '@jest/globals'
import { err, ok } from '../../../../src/core/result.js'
import type { SkillResult } from '../../../../src/core/skill.types.js'
import {
  CollectSaplingsSkill,
  type CollectSaplingsInput,
} from '../../../../src/skills/farming/collect-saplings-skill.js'
import type {
  CollectInput,
  CollectOutput,
} from '../../../../src/skills/gathering/collect-blocks-skill.js'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeBlockScanner, FakeInventory } from '../../../fakes/fake-ports.js'
import {
  AutoScheduler,
  FakeDroppedItems,
  InstantNavigator,
  skillContext,
} from '../../../fakes/gathering-fakes.js'

const ALL_LEAVES = ['oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'cherry_leaves', 'stone']

/** A block collector that breaks leaves and drops a sapling on the given (1-based) leaf numbers. */
class FakeLeafBreaker {
  readonly calls: CollectInput[] = []
  /** Leaves broken so far, all calls together. */
  broken = 0
  /** Which leaf numbers drop a sapling, and which sapling. */
  drops = new Map<number, string>()
  /** Leaves that can be broken before the collector runs out (undefined: no limit). */
  available: number | undefined
  /** What to fail with once `available` is used up. */
  outOf: { reason: string; message: string } = { reason: 'block_not_found', message: 'No leaves within 32 blocks.' }

  constructor(private readonly inventory: FakeInventory) {}

  run(input: CollectInput): Promise<SkillResult<CollectOutput>> {
    this.calls.push(input)
    let mined = 0
    while (mined < input.count) {
      if (this.available !== undefined && this.broken >= this.available)
        return Promise.resolve(err({ ...this.outOf, detail: { mined, requested: input.count, remaining: input.count - mined } }))
      this.broken += 1
      mined += 1
      const sapling = this.drops.get(this.broken)
      if (sapling !== undefined) this.add(sapling)
    }
    return Promise.resolve(ok({ mined, requested: input.count, gained: [] }))
  }

  add(name: string): void {
    const stacks = [...(this.inventory.value?.stacks ?? [])]
    const index = stacks.findIndex((stack) => stack.name === name)
    const found = stacks[index]
    if (found === undefined) stacks.push({ name, count: 1 })
    else stacks[index] = { name, count: found.count + 1 }
    this.inventory.value = { stacks, emptySlots: 20, heldItem: undefined }
  }
}

function setup() {
  const clock = new FakeClock(0)
  const inventory = new FakeInventory()
  inventory.value = { stacks: [], emptySlots: 20, heldItem: undefined }
  const blocks = new FakeBlockScanner()
  blocks.names = ALL_LEAVES
  const leaves = new FakeLeafBreaker(inventory)
  const droppedItems = new FakeDroppedItems()
  const navigator = new InstantNavigator()
  navigator.onArrive = (target) => {
    for (const item of droppedItems.items) {
      if (Math.hypot(item.position.x - target.x, item.position.z - target.z) > 1) continue
      for (let i = 0; i < item.count; i += 1) leaves.add(item.name)
      droppedItems.remove(item.entityId)
    }
  }
  const drops = new DropCollector({ drops: droppedItems, navigator, scheduler: new AutoScheduler(clock) })
  const skill = new CollectSaplingsSkill({ blocks, inventory, leaves, drops })
  return { skill, leaves, droppedItems, inventory, blocks }
}

const input = (over: Partial<CollectSaplingsInput> = {}): CollectSaplingsInput => ({
  species: 'oak',
  count: 2,
  maxLeaves: undefined,
  maxDistance: 32,
  ...over,
})

describe('CollectSaplingsSkill', () => {
  it('breaks the species’ leaves in small batches until enough saplings dropped', async () => {
    const s = setup()
    s.leaves.drops = new Map([[5, 'oak_sapling'], [11, 'oak_sapling']])

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { saplings: 2, requested: 2, leaves: 16 } })
    expect(s.leaves.calls.map((call) => call.names)).toEqual([['oak_leaves'], ['oak_leaves']])
    expect(s.leaves.calls.every((call) => call.count <= 8 && call.maxDistance === 32)).toBe(true)
    expect(result.ok && result.value.gained).toEqual([{ name: 'oak_sapling', count: 2 }])
  })

  it('counts only the wanted species, and reports what else came with the leaves', async () => {
    const s = setup()
    s.leaves.drops = new Map([[2, 'birch_sapling'], [3, 'oak_sapling'], [4, 'apple']])

    const result = await s.skill.run(input({ count: 1 }), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { saplings: 1, leaves: 8 } })
    expect(result.ok && result.value.gained).toEqual(
      expect.arrayContaining([
        { name: 'oak_sapling', count: 1 },
        { name: 'birch_sapling', count: 1 },
        { name: 'apple', count: 1 },
      ]),
    )
  })

  it('takes any species, and every leaf kind the game knows, when none is named', async () => {
    const s = setup()
    s.leaves.drops = new Map([[1, 'birch_sapling'], [2, 'spruce_sapling']])

    const result = await s.skill.run(input({ species: undefined }), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { saplings: 2 } })
    expect(s.leaves.calls[0]?.names).toEqual([
      'oak_leaves',
      'birch_leaves',
      'spruce_leaves',
      'jungle_leaves',
      'acacia_leaves',
      'dark_oak_leaves',
      'cherry_leaves',
    ])
  })

  it('picks up saplings lying around first, and needs no leaves when that is enough', async () => {
    const s = setup()
    s.droppedItems.drop('oak_sapling', { x: 3, y: 64, z: 0 }, 3, 2)
    s.droppedItems.drop('birch_sapling', { x: 4, y: 64, z: 0 }, 4, 5)

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { saplings: 2, leaves: 0 } })
    expect(s.leaves.calls).toEqual([])
  })

  it('gives up at the leaf budget, saying how far it got', async () => {
    const s = setup()
    s.leaves.drops = new Map([[3, 'oak_sapling']])

    const result = await s.skill.run(input({ maxLeaves: 20 }), skillContext().context)

    expect(result).toMatchObject({
      ok: false,
      error: {
        reason: 'leaf_budget',
        detail: { saplings: 1, requested: 2, leaves: 20 },
        message: expect.stringContaining('Got 1 of 2 saplings from 20 leaves'),
      },
    })
    expect(s.leaves.calls.map((call) => call.count)).toEqual([8, 8, 4])
  })

  it('allows 40 leaves per sapling wanted, and never more than 1000', async () => {
    const s = setup()
    await s.skill.run(input({ count: 1 }), skillContext().context)
    const big = setup()
    await big.skill.run(input({ count: 64 }), skillContext().context)

    expect(s.leaves.broken).toBe(40)
    expect(big.leaves.broken).toBe(1000)
  })

  it('stops with no_leaves when the collector runs out, keeping the leaves it broke', async () => {
    const s = setup()
    s.leaves.available = 10
    s.leaves.drops = new Map([[4, 'oak_sapling']])

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'no_leaves', detail: { saplings: 1, requested: 2, leaves: 10 } },
    })
  })

  it('passes on any other reason the collector stops for', async () => {
    const s = setup()
    s.leaves.available = 3
    s.leaves.outOf = { reason: 'protected_area', message: 'The nearest leaves are inside "house".' }

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'protected_area', message: expect.stringContaining('inside "house"') },
    })
  })

  it('succeeds when the collector stops after the last sapling dropped', async () => {
    const s = setup()
    s.leaves.available = 5
    s.leaves.drops = new Map([[5, 'oak_sapling']])

    const result = await s.skill.run(input({ count: 1 }), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { saplings: 1, leaves: 5 } })
  })

  it('stops when no leaf could be broken at all', async () => {
    const s = setup()
    s.leaves.run = () => Promise.resolve(ok({ mined: 0, requested: 8, gained: [] }))

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_leaves' } })
  })

  it('stops when the game has no leaves of that kind', async () => {
    const s = setup()
    s.blocks.names = ['stone']

    const result = await s.skill.run(input({ species: undefined }), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_leaves' } })
    expect(s.leaves.calls).toEqual([])
  })

  it('stops when cancelled', async () => {
    const s = setup()
    const { context, controller } = skillContext()
    controller.abort()

    const result = await s.skill.run(input(), context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
  })

  it('refuses a species it does not know', async () => {
    const result = await setup().skill.run(input({ species: 'mangrove' }), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'unknown_species' } })
  })

  it('passes the inventory-full choice on to the collector', async () => {
    const s = setup()
    s.leaves.drops = new Map([[1, 'oak_sapling']])

    await s.skill.run(input({ count: 1, onInventoryFull: 'stop' }), skillContext().context)

    expect(s.leaves.calls[0]?.onInventoryFull).toBe('stop')
  })
})
