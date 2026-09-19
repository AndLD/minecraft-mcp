import { describe, expect, it } from '@jest/globals'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import { PickupItemsSkill } from '../../../../src/skills/gathering/pickup-items-skill.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeInventory } from '../../../fakes/fake-ports.js'
import {
  AutoScheduler,
  FakeDroppedItems,
  InstantNavigator,
  skillContext,
} from '../../../fakes/gathering-fakes.js'

function setup() {
  const clock = new FakeClock()
  const drops = new FakeDroppedItems()
  const navigator = new InstantNavigator()
  const inventory = new FakeInventory()
  inventory.value = { stacks: [], emptySlots: 20, heldItem: undefined }
  const collector = new DropCollector({ drops, navigator, scheduler: new AutoScheduler(clock) })
  const skill = new PickupItemsSkill(collector, inventory)

  navigator.onArrive = (target) => {
    for (const item of drops.items) {
      if (Math.hypot(item.position.x - target.x, item.position.z - target.z) > 1) continue
      inventory.value = {
        stacks: [...(inventory.value?.stacks ?? []), { name: item.name, count: item.count }],
        emptySlots: inventory.value?.emptySlots ?? 0,
        heldItem: undefined,
      }
      drops.remove(item.entityId)
    }
  }
  return { clock, drops, navigator, inventory, collector, skill }
}

describe('PickupItemsSkill', () => {
  it('walks onto every dropped item, nearest first, and reports what it picked up', async () => {
    const world = setup()
    world.drops.drop('oak_log', { x: 8, y: 64, z: 0 }, 8, 2)
    world.drops.drop('apple', { x: 3, y: 64, z: 0 }, 3)
    const { context, progress } = skillContext()

    const result = await world.skill.run({ names: [], maxDistance: 12 }, context)

    expect(world.navigator.trips.map((t) => t.target.x)).toEqual([3, 8])
    expect(result).toEqual({
      ok: true,
      value: {
        picked: [
          { name: 'oak_log', count: 2 },
          { name: 'apple', count: 1 },
        ],
        remaining: 0,
      },
    })
    expect(progress).toEqual(['Picking up 2 item stack(s)'])
  })

  it('takes only the wanted items', async () => {
    const world = setup()
    world.drops.drop('oak_log', { x: 2, y: 64, z: 0 })
    world.drops.drop('apple', { x: 4, y: 64, z: 0 }, 4)

    const result = await world.skill.run(
      { names: ['apple'], maxDistance: 12 },
      skillContext().context,
    )

    expect(world.navigator.trips.map((t) => t.target.x)).toEqual([4])
    expect(result).toMatchObject({
      ok: true,
      value: { picked: [{ name: 'apple', count: 1 }], remaining: 0 },
    })
  })

  it('ignores items beyond the search distance', async () => {
    const world = setup()
    world.drops.drop('apple', { x: 30, y: 64, z: 0 }, 30)

    const result = await world.skill.run({ names: [], maxDistance: 12 }, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_items_nearby' } })
  })

  it('names the wanted item in the "nothing there" message', async () => {
    const result = await setup().skill.run(
      { names: ['diamond'], maxDistance: 5 },
      skillContext().context,
    )

    expect(!result.ok && result.error.message).toBe('No diamond within 5 blocks.')
  })

  it('says so when the inventory is full and nothing could be taken', async () => {
    const world = setup()
    world.drops.drop('apple', { x: 2, y: 64, z: 0 })
    world.navigator.onArrive = () => undefined // the game would not pick it up
    world.inventory.value = { stacks: [], emptySlots: 0, heldItem: undefined }

    const result = await world.skill.run({ names: [], maxDistance: 12 }, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'inventory_full' } })
  })

  it('reports an unreachable item as a failed pickup', async () => {
    const world = setup()
    world.drops.drop('apple', { x: 2, y: 64, z: 0 })
    world.navigator.failures = [{ reason: 'unreachable', message: 'No path' }]

    const result = await world.skill.run({ names: [], maxDistance: 12 }, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'pickup_failed' } })
  })

  it('counts stacks left behind', async () => {
    const world = setup()
    world.drops.drop('apple', { x: 2, y: 64, z: 0 })
    world.drops.drop('stick', { x: 4, y: 64, z: 0 }, 4)
    world.navigator.failures = [undefined, { reason: 'unreachable', message: 'No path' }]

    const result = await world.skill.run({ names: [], maxDistance: 12 }, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { remaining: 1 } })
  })

  it('stops when cancelled', async () => {
    const world = setup()
    world.drops.drop('apple', { x: 2, y: 64, z: 0 })
    const { context, controller } = skillContext()
    controller.abort()

    const result = await world.skill.run({ names: [], maxDistance: 12 }, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
  })
})

describe('DropCollector', () => {
  it('tries each item once, so an item that cannot be picked up does not loop', async () => {
    const world = setup()
    world.drops.drop('apple', { x: 2, y: 64, z: 0 })
    world.navigator.onArrive = () => undefined

    await world.collector.collect({ maxDistance: 12 }, new AbortController().signal)

    expect(world.navigator.trips).toHaveLength(1)
  })

  it('skips items the extra test rejects', async () => {
    const world = setup()
    world.drops.drop('apple', { x: 2, y: 64, z: 0 })
    world.drops.drop('stick', { x: 4, y: 64, z: 0 })

    await world.collector.collect(
      { maxDistance: 12, accept: (item) => item.name === 'stick' },
      new AbortController().signal,
    )

    expect(world.navigator.trips.map((trip) => trip.target.x)).toEqual([4])
  })

  it('collects only what dropped near the broken block', async () => {
    const world = setup()
    world.drops.drop('oak_log', { x: 5, y: 64, z: 0 }, 5)
    world.drops.drop('apple', { x: 30, y: 64, z: 0 }, 9)

    await world.collector.collectNear({ x: 5, y: 64, z: 0 }, new AbortController().signal)

    expect(world.navigator.trips.map((t) => t.target.x)).toEqual([5])
  })

  it('waits a moment for drops to appear, and stops when aborted', async () => {
    const world = setup()
    const controller = new AbortController()
    controller.abort()

    await world.collector.collectNear({ x: 0, y: 64, z: 0 }, controller.signal)

    expect(world.clock.now()).toBe(0)
    expect(world.navigator.trips).toEqual([])
  })

  it('stops sweeping when a trip is aborted', async () => {
    const world = setup()
    world.drops.drop('apple', { x: 2, y: 64, z: 0 })
    world.drops.drop('stick', { x: 4, y: 64, z: 0 }, 4)
    world.navigator.failures = [{ reason: 'aborted', message: 'Cancelled.' }]

    await world.collector.collect({ maxDistance: 12 }, new AbortController().signal)

    expect(world.navigator.trips).toHaveLength(1)
  })
})
