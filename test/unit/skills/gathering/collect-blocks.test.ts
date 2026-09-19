import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { BlockFinder } from '../../../../src/perception/block-finder.js'
import { CollectBlocksSkill } from '../../../../src/skills/gathering/collect-blocks-skill.js'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import {
  FakeBlockScanner,
  FakeInventory,
  FakeVitals,
  buildVitals,
} from '../../../fakes/fake-ports.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import {
  AutoScheduler,
  FakeAreaGuard,
  FakeDigger,
  FakeDroppedItems,
  InstantNavigator,
  assessment,
  skillContext,
} from '../../../fakes/gathering-fakes.js'

const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`

/** A small world: the bot at the origin, blocks that dig away and drop items that are picked up by walking onto them. */
function setup() {
  const clock = new FakeClock()
  const scheduler = new AutoScheduler(clock)
  const scanner = new FakeBlockScanner()
  scanner.names = ['oak_log', 'birch_log', 'stone', 'iron_ore', 'lava']
  const digger = new FakeDigger()
  const navigator = new InstantNavigator()
  const drops = new FakeDroppedItems()
  const inventory = new FakeInventory()
  inventory.value = { stacks: [], emptySlots: 30, heldItem: undefined }
  const vitals = new FakeVitals()
  vitals.vitals = buildVitals({ position: { x: 0, y: 64, z: 0 } })
  const guard = new FakeAreaGuard()
  const collector = new DropCollector({ drops, navigator, scheduler })
  const skill = new CollectBlocksSkill({
    blocks: scanner,
    finder: new BlockFinder(scanner),
    digger,
    navigator,
    inventory,
    vitals,
    drops: collector,
    guard,
  })

  const give = (name: string, count: number): void => {
    const stacks = inventory.value?.stacks ?? []
    const existing = stacks.find((s) => s.name === name)
    inventory.value = {
      stacks: existing
        ? stacks.map((s) => (s === existing ? { name, count: s.count + count } : s))
        : [...stacks, { name, count }],
      emptySlots: inventory.value?.emptySlots ?? 0,
      heldItem: undefined,
    }
  }

  /** Digging removes the block and leaves its drop; walking onto a drop picks it up. */
  digger.onDug = (position) => {
    scanner.blocks = scanner.blocks.filter((b) => key(b.position) !== key(position))
    drops.drop(digger.assess(position)?.blockName ?? 'oak_log', position, 1)
  }
  navigator.onArrive = (target) => {
    for (const item of drops.items) {
      if (
        Math.hypot(
          item.position.x - target.x,
          item.position.y - target.y,
          item.position.z - target.z,
        ) <= 1
      ) {
        give(item.name, item.count)
        drops.remove(item.entityId)
      }
    }
  }

  /** A block with open air above it (so it can be dug), nearest first by distance. */
  const addBlock = (name: string, position: Position, distance: number): void => {
    scanner.blocks = [...scanner.blocks, { name, position, distance }].sort(
      (a, b) => a.distance - b.distance,
    )
    digger.nameAt(position, name)
    scanner.solid.set(key({ ...position, y: position.y + 1 }), false)
  }

  return { scanner, digger, navigator, drops, inventory, vitals, guard, skill, give, addBlock }
}

const input = (over: Partial<Parameters<CollectBlocksSkill['run']>[0]> = {}) => ({
  names: ['oak_log'],
  count: 3,
  maxDistance: 32,
  ...over,
})

describe('CollectBlocksSkill', () => {
  it('breaks the nearest blocks first, walks up to them, and picks up the drops', async () => {
    const world = setup()
    world.addBlock('oak_log', { x: 10, y: 64, z: 0 }, 10)
    world.addBlock('oak_log', { x: 5, y: 64, z: 0 }, 5)
    world.addBlock('oak_log', { x: 7, y: 64, z: 0 }, 7)
    const { context, progress } = skillContext()

    const result = await world.skill.run(input(), context)

    expect(world.digger.dug).toEqual([
      { x: 5, y: 64, z: 0 },
      { x: 7, y: 64, z: 0 },
      { x: 10, y: 64, z: 0 },
    ])
    expect(world.navigator.trips[0]).toEqual({ target: { x: 5, y: 64, z: 0 }, within: 3 })
    expect(result).toEqual({
      ok: true,
      value: { mined: 3, requested: 3, gained: [{ name: 'oak_log', count: 3 }] },
    })
    expect(progress).toEqual([
      'Collected 1 of 3 (oak_log)',
      'Collected 2 of 3 (oak_log)',
      'Collected 3 of 3 (oak_log)',
    ])
  })

  it('reports each block through onMined', async () => {
    const world = setup()
    world.addBlock('oak_log', { x: 4, y: 64, z: 0 }, 4)
    world.addBlock('oak_log', { x: 5, y: 64, z: 0 }, 5)
    const mined: number[] = []

    await world.skill.run(
      input({ count: 2, onMined: (n) => mined.push(n) }),
      skillContext().context,
    )

    expect(mined).toEqual([1, 2])
  })

  it('searches every log type for the group name "logs"', async () => {
    const world = setup()
    world.addBlock('birch_log', { x: 4, y: 64, z: 0 }, 4)

    const result = await world.skill.run(
      input({ names: ['logs'], count: 1 }),
      skillContext().context,
    )

    expect(world.scanner.queries[0]?.names).toEqual(['oak_log', 'birch_log'])
    expect(result.ok).toBe(true)
  })

  it('stops with the reason and what it managed when the blocks run out', async () => {
    const world = setup()
    world.addBlock('oak_log', { x: 4, y: 64, z: 0 }, 4)

    const result = await world.skill.run(input({ count: 5 }), skillContext().context)

    expect(result).toMatchObject({
      ok: false,
      error: {
        reason: 'block_not_found',
        detail: { mined: 1, requested: 5, remaining: 4 },
      },
    })
    expect(!result.ok && result.error.message).toContain(
      'Collected 1 of 5 (inventory gained 1 oak_log)',
    )
  })

  it('fails at once with hints for a name that is not a block', async () => {
    const world = setup()

    const result = await world.skill.run(input({ names: ['oak_lo'] }), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'unknown_block' } })
  })

  it('does not dig a block that is buried, and says so', async () => {
    const world = setup()
    world.addBlock('stone', { x: 4, y: 64, z: 0 }, 4)
    world.scanner.solid.set(key({ x: 4, y: 65, z: 0 }), true) // covered on every side

    const result = await world.skill.run(
      input({ names: ['stone'], count: 1 }),
      skillContext().context,
    )

    expect(world.digger.dug).toEqual([])
    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'not_reachable_without_tunnelling' },
    })
  })

  it('leaves the block under its feet alone, but digs one beside it', async () => {
    const world = setup()
    world.addBlock('stone', { x: 0, y: 63, z: 0 }, 1)
    world.addBlock('stone', { x: 1, y: 63, z: 0 }, 1.4)

    const result = await world.skill.run(
      input({ names: ['stone'], count: 1 }),
      skillContext().context,
    )

    expect(world.digger.dug).toEqual([{ x: 1, y: 63, z: 0 }])
    expect(result.ok).toBe(true)
  })

  it('does not dig a block that touches lava', async () => {
    const world = setup()
    world.addBlock('stone', { x: 4, y: 64, z: 0 }, 4)
    world.scanner.blockNames.set(key({ x: 5, y: 64, z: 0 }), 'lava')
    world.scanner.solid.set(key({ x: 5, y: 64, z: 0 }), false)

    const result = await world.skill.run(
      input({ names: ['stone'], count: 1 }),
      skillContext().context,
    )

    expect(world.digger.dug).toEqual([])
    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'not_reachable_without_tunnelling' },
    })
  })

  it('never digs in a protected area, but still digs elsewhere', async () => {
    const world = setup()
    world.addBlock('oak_log', { x: 4, y: 64, z: 0 }, 4)
    world.addBlock('oak_log', { x: 20, y: 64, z: 0 }, 20)
    world.guard.protect('my house', (p) => p.x < 10)

    const partial = await world.skill.run(input({ count: 2 }), skillContext().context)

    expect(world.digger.dug).toEqual([{ x: 20, y: 64, z: 0 }])
    expect(partial).toMatchObject({ ok: false, error: { reason: 'protected_area' } })
    expect(!partial.ok && partial.error.message).toContain('my house')
  })

  it('refuses when only a protected block is around', async () => {
    const world = setup()
    world.addBlock('oak_log', { x: 4, y: 64, z: 0 }, 4)
    world.guard.protect('farm', () => true)

    const result = await world.skill.run(input({ count: 1 }), skillContext().context)

    expect(world.digger.dug).toEqual([])
    expect(result).toMatchObject({ ok: false, error: { reason: 'protected_area' } })
  })

  it('names the tools it lacks instead of wasting the block', async () => {
    const world = setup()
    world.addBlock('iron_ore', { x: 4, y: 64, z: 0 }, 4)
    world.digger.assessments.set(
      'iron_ore',
      assessment({
        blockName: 'iron_ore',
        canHarvest: false,
        requiredTools: ['stone_pickaxe', 'iron_pickaxe'],
      }),
    )

    const result = await world.skill.run(
      input({ names: ['iron_ore'], count: 2 }),
      skillContext().context,
    )

    expect(world.digger.dug).toEqual([])
    expect(world.navigator.trips).toEqual([])
    expect(result).toMatchObject({ ok: false, error: { reason: 'no_suitable_tool' } })
    expect(!result.ok && result.error.message).toContain('stone_pickaxe, iron_pickaxe')
  })

  it('skips blocks that cannot be dug or are not loaded', async () => {
    const world = setup()
    world.addBlock('oak_log', { x: 4, y: 64, z: 0 }, 4)
    world.addBlock('oak_log', { x: 6, y: 64, z: 0 }, 6)
    world.digger.assessments.set('oak_log', assessment({ diggable: false }))

    const result = await world.skill.run(input({ count: 1 }), skillContext().context)

    expect(world.digger.dug).toEqual([])
    expect(result.ok).toBe(false)
  })

  describe('when a block cannot be reached', () => {
    it('moves on to the next block', async () => {
      const world = setup()
      world.addBlock('oak_log', { x: 4, y: 64, z: 0 }, 4)
      world.addBlock('oak_log', { x: 6, y: 64, z: 0 }, 6)
      world.navigator.failures = [{ reason: 'unreachable', message: 'No path' }]

      const result = await world.skill.run(input({ count: 1 }), skillContext().context)

      expect(world.digger.dug).toEqual([{ x: 6, y: 64, z: 0 }])
      expect(result.ok).toBe(true)
    })

    it('gives up when several blocks in a row are out of reach', async () => {
      const world = setup()
      for (let i = 1; i <= 8; i += 1) world.addBlock('oak_log', { x: i * 3, y: 64, z: 0 }, i * 3)
      world.navigator.failures = Array.from({ length: 8 }, () => ({
        reason: 'unreachable' as const,
        message: 'No path',
      }))

      const result = await world.skill.run(input({ count: 4 }), skillContext().context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'unreachable' } })
      expect(world.navigator.trips).toHaveLength(6)
    })

    it('reports unreachable when the blocks left were all given up on', async () => {
      const world = setup()
      world.addBlock('oak_log', { x: 4, y: 64, z: 0 }, 4)
      world.navigator.failures = [{ reason: 'unreachable', message: 'No path' }]

      const result = await world.skill.run(input({ count: 1 }), skillContext().context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'unreachable' } })
    })

    it('stops when the walk is aborted', async () => {
      const world = setup()
      world.addBlock('oak_log', { x: 4, y: 64, z: 0 }, 4)
      world.navigator.failures = [{ reason: 'aborted', message: 'Cancelled.' }]

      const result = await world.skill.run(input(), skillContext().context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    })
  })

  describe('when digging goes wrong', () => {
    it('steps closer and digs again when the block is out of reach', async () => {
      const world = setup()
      world.addBlock('oak_log', { x: 4, y: 64, z: 0 }, 4)
      world.digger.failures = [{ reason: 'out_of_reach', message: 'too far' }]

      const result = await world.skill.run(input({ count: 1 }), skillContext().context)

      expect(world.navigator.trips.slice(0, 2).map((t) => t.within)).toEqual([3, 1.5])
      expect(world.digger.dug).toHaveLength(1)
      expect(result.ok).toBe(true)
    })

    it('skips a block that fails to dig and tries the next', async () => {
      const world = setup()
      world.addBlock('oak_log', { x: 4, y: 64, z: 0 }, 4)
      world.addBlock('oak_log', { x: 6, y: 64, z: 0 }, 6)
      world.digger.failures = [{ reason: 'failed', message: 'server said no' }]

      const result = await world.skill.run(input({ count: 1 }), skillContext().context)

      expect(world.digger.dug).toEqual([{ x: 6, y: 64, z: 0 }])
      expect(result.ok).toBe(true)
    })

    it('stops when the dig is aborted', async () => {
      const world = setup()
      world.addBlock('oak_log', { x: 4, y: 64, z: 0 }, 4)
      world.digger.failures = [{ reason: 'aborted', message: 'Cancelled.' }]

      const result = await world.skill.run(input(), skillContext().context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    })
  })

  it('stops with a resumable inventory_full state when there is no room', async () => {
    const world = setup()
    world.addBlock('oak_log', { x: 4, y: 64, z: 0 }, 4)
    world.addBlock('oak_log', { x: 5, y: 64, z: 0 }, 5)
    world.addBlock('oak_log', { x: 6, y: 64, z: 0 }, 6)
    world.digger.onDug = ((original) => (position: Position) => {
      original(position)
      if (world.digger.dug.length === 2 && world.inventory.value !== undefined)
        world.inventory.value = { ...world.inventory.value, emptySlots: 0 }
    })(world.digger.onDug)

    const result = await world.skill.run(input({ count: 3 }), skillContext().context)

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'inventory_full', detail: { mined: 2, requested: 3, remaining: 1 } },
    })
    expect(world.digger.dug).toHaveLength(2)
  })

  it('does not start when the inventory is already full', async () => {
    const world = setup()
    world.addBlock('oak_log', { x: 4, y: 64, z: 0 }, 4)
    world.inventory.value = { stacks: [], emptySlots: 0, heldItem: undefined }

    const result = await world.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'inventory_full' } })
    expect(world.digger.dug).toEqual([])
  })

  it('stops between blocks when cancelled, keeping what it has', async () => {
    const world = setup()
    world.addBlock('oak_log', { x: 4, y: 64, z: 0 }, 4)
    world.addBlock('oak_log', { x: 5, y: 64, z: 0 }, 5)
    world.addBlock('oak_log', { x: 6, y: 64, z: 0 }, 6)
    const { context, controller } = skillContext()
    world.digger.onDug = ((original) => (position: Position) => {
      original(position)
      controller.abort()
    })(world.digger.onDug)

    const result = await world.skill.run(input(), context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted', detail: { mined: 1 } } })
    expect(world.digger.dug).toHaveLength(1)
  })

  it('reports not connected when the inventory cannot be read', async () => {
    const world = setup()
    world.inventory.value = undefined

    const result = await world.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
  })
})
