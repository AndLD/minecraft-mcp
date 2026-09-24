import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { ok, type Result } from '../../../../src/core/result.js'
import { GroveSpotFinder } from '../../../../src/skills/farming/grove-spots.js'
import {
  PlantTreesSkill,
  type AreaProtector,
  type PlantTreesInput,
} from '../../../../src/skills/farming/plant-trees-skill.js'
import { FarmRegistry } from '../../../../src/state/farm-registry.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeInventory } from '../../../fakes/fake-ports.js'
import { FakeAreaGuard, InstantNavigator, skillContext } from '../../../fakes/gathering-fakes.js'
import { GrovePlacer, GroveWorld } from '../../../fakes/grove-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const GROUND = 64
const at = (x: number, y: number, z: number): Position => ({ x, y, z })
const rect = (x0: number, z0: number, x1: number, z1: number) => ({ from: at(x0, GROUND, z0), to: at(x1, GROUND, z1) })

class FakeProtector implements AreaProtector {
  readonly added: { label: string; from: Position; to: Position }[] = []
  add(label: string, from: Position, to: Position): Result<unknown> {
    this.added.push({ label, from, to })
    return ok(undefined)
  }
}

async function setup(saplings: Record<string, number> = { oak_sapling: 20 }) {
  const world = new GroveWorld({ x0: -10, x1: 40, z0: -10, z1: 40, y0: 50, y1: 90 })
  world.ground(-10, -10, 40, 40, GROUND)
  const inventory = new FakeInventory()
  const carried = new Map(Object.entries(saplings))
  const sync = (): void => {
    inventory.value = {
      stacks: [...carried].map(([name, count]) => ({ name, count })),
      emptySlots: 20,
      heldItem: undefined,
    }
  }
  sync()
  const placer = new GrovePlacer(world)
  placer.onPlaced = (item) => {
    carried.set(item, (carried.get(item) ?? 0) - 1)
    sync()
  }
  const navigator = new InstantNavigator()
  const guard = new FakeAreaGuard()
  const farms = new FarmRegistry(new FakeClock(0))
  await farms.attach(new InMemoryStateStore())
  const protector = new FakeProtector()
  const skill = new PlantTreesSkill({
    blocks: world,
    navigator,
    placer,
    inventory,
    farms,
    finder: new GroveSpotFinder({ blocks: world, guard, farms }),
    protectedAreas: protector,
  })
  return { world, placer, navigator, farms, protector, skill, carried, sync }
}

const input = (over: Partial<PlantTreesInput> = {}): PlantTreesInput => ({
  species: 'oak',
  count: 4,
  farm: undefined,
  area: rect(0, 0, 12, 12),
  around: undefined,
  spacing: undefined,
  big: undefined,
  preview: false,
  label: undefined,
  group: undefined,
  ...over,
})

describe('PlantTreesSkill', () => {
  it('plants saplings at spots, registers a grove with them, and protects it', async () => {
    const s = await setup()

    const result = await s.skill.run(input({ label: 'oak wood' }), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { mode: 'plant', species: 'oak', requested: 4, planted: 4, skipped: 0, saplingsMissing: 0, protectedArea: true },
    })
    expect(s.placer.placed).toHaveLength(4)
    expect(s.placer.placed.every((p) => p.item === 'oak_sapling' && p.at.y === GROUND + 1)).toBe(true)
    expect(s.navigator.trips).toHaveLength(4)
    const grove = s.farms.resolve('oak wood')
    expect(grove).toMatchObject({ kind: 'grove', crop: 'oak', builtByBot: true, bounds: rect(0, 0, 12, 12) })
    expect(grove?.spots).toHaveLength(4)
    expect(s.protector.added).toEqual([
      { label: 'oak wood', from: at(0, GROUND - 1, 0), to: at(12, GROUND + 24, 12) },
    ])
  })

  it('only previews when asked: nothing placed, nothing registered', async () => {
    const s = await setup()

    const result = await s.skill.run(input({ preview: true }), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { mode: 'preview', planted: 0, capacity: 16 } })
    if (result.ok) expect(result.value.spots).toHaveLength(4)
    expect(s.placer.placed).toEqual([])
    expect(s.farms.all()).toEqual([])
  })

  it('plants in a ring around a house, without protecting anything', async () => {
    const s = await setup()

    const result = await s.skill.run(
      input({
        count: 8,
        area: undefined,
        around: { from: at(10, GROUND, 10), to: at(14, GROUND, 14), distance: 2, depth: 4 },
      }),
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { planted: 8, protectedArea: false } })
    for (const p of s.placer.placed)
      expect(p.at.x >= 8 && p.at.x <= 16 && p.at.z >= 8 && p.at.z <= 16).toBe(false)
    expect(s.protector.added).toEqual([])
    expect(s.farms.all()[0]?.bounds.from.x).toBeLessThan(8)
  })

  it('plants what it has and reports the saplings it lacked', async () => {
    const s = await setup({ oak_sapling: 2 })

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { planted: 2, saplingsMissing: 2 } })
    expect(s.farms.all()[0]?.spots).toHaveLength(2)
  })

  it('fails with no_saplings when it has none, planting and registering nothing', async () => {
    const s = await setup({})

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_saplings' } })
    expect(s.farms.all()).toEqual([])
  })

  it('plants four saplings for a big tree, and needs all four', async () => {
    const s = await setup({ dark_oak_sapling: 6 })

    const result = await s.skill.run(
      input({ species: 'dark_oak', count: 2, area: rect(0, 0, 16, 16) }),
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { planted: 1, saplingsMissing: 2 } })
    expect(s.placer.placed).toHaveLength(4)
    expect(s.farms.all()[0]?.spots?.[0]?.size).toBe(2)
  })

  it('skips a spot the bot cannot reach', async () => {
    const s = await setup()
    s.navigator.failures = [{ reason: 'unreachable', message: 'no path' }]

    const result = await s.skill.run(input({ count: 3 }), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { planted: 2, skipped: 1 } })
  })

  it('keeps what it planted when cancelled part way', async () => {
    const s = await setup()
    const { context, controller } = skillContext()
    s.navigator.onArrive = () => {
      if (s.placer.placed.length >= 1) controller.abort()
    }

    const result = await s.skill.run(input(), context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(s.farms.all()[0]?.spots?.length).toBeGreaterThan(0)
  })

  it('adds trees to a grove it is pointed at', async () => {
    const s = await setup()
    const grove = s.farms.register({ kind: 'grove', crop: 'oak', bounds: rect(0, 0, 12, 12), label: 'wood' })
    if (!grove.ok) throw new Error(grove.error)

    const result = await s.skill.run(input({ area: undefined, farm: 'wood', count: 3 }), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { mode: 'plant', planted: 3, farm: grove.value.id } })
    expect(s.farms.all()).toHaveLength(1)
    expect(s.farms.get(grove.value.id)?.spots).toHaveLength(3)
  })

  describe('refilling a grove', () => {
    async function planted() {
      const s = await setup()
      await s.skill.run(input({ label: 'wood' }), skillContext().context)
      s.placer.placed.length = 0
      return s
    }

    it('plants only the spots where a tree is gone', async () => {
      const s = await planted()
      const spots = s.farms.resolve('wood')?.spots ?? []
      const [gone, grown] = spots
      if (gone === undefined || grown === undefined) throw new Error('spots')
      s.world.set(gone.x, gone.y, gone.z, 'air')
      s.world.set(grown.x, grown.y, grown.z, 'oak_log')

      const result = await s.skill.run(
        input({ area: undefined, count: undefined, farm: 'wood', species: undefined }),
        skillContext().context,
      )

      expect(result).toMatchObject({ ok: true, value: { mode: 'replant', requested: 1, planted: 1 } })
      expect(s.placer.placed).toEqual([{ item: 'oak_sapling', at: at(gone.x, gone.y, gone.z) }])
      expect(s.farms.all()).toHaveLength(1)
    })

    it('does nothing when every spot has its tree', async () => {
      const s = await planted()

      const result = await s.skill.run(
        input({ area: undefined, count: undefined, farm: 'wood', species: undefined }),
        skillContext().context,
      )

      expect(result).toMatchObject({ ok: true, value: { mode: 'replant', planted: 0, requested: 0 } })
    })

    it('reports the empty spots when previewing', async () => {
      const s = await planted()
      const spot = s.farms.resolve('wood')?.spots?.[0]
      if (spot === undefined) throw new Error('spot')
      s.world.set(spot.x, spot.y, spot.z, 'air')

      const result = await s.skill.run(
        input({ area: undefined, count: undefined, farm: 'wood', species: undefined, preview: true }),
        skillContext().context,
      )

      expect(result).toMatchObject({ ok: true, value: { mode: 'preview', spots: [spot] } })
      expect(s.placer.placed).toEqual([])
    })

    it('reports the saplings it lacks for the empty spots', async () => {
      const s = await planted()
      s.carried.set('oak_sapling', 0)
      s.sync()
      const spot = s.farms.resolve('wood')?.spots?.[0]
      if (spot === undefined) throw new Error('spot')
      s.world.set(spot.x, spot.y, spot.z, 'air')

      const result = await s.skill.run(
        input({ area: undefined, count: undefined, farm: 'wood', species: undefined }),
        skillContext().context,
      )

      expect(result).toMatchObject({ ok: true, value: { planted: 0, saplingsMissing: 1 } })
    })

    it('stops when cancelled', async () => {
      const s = await planted()
      const spot = s.farms.resolve('wood')?.spots?.[0]
      if (spot === undefined) throw new Error('spot')
      s.world.set(spot.x, spot.y, spot.z, 'air')
      const { context, controller } = skillContext()
      controller.abort()

      const result = await s.skill.run(
        input({ area: undefined, count: undefined, farm: 'wood', species: undefined }),
        context,
      )

      expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    })
  })

  describe('refuses', () => {
    it.each([
      ['an unknown farm', { farm: 'nothing' }, 'unknown_farm'],
      ['a species it cannot plant', { species: 'mangrove' }, 'unknown_species'],
      ['no species', { species: undefined }, 'no_species'],
      ['a big oak', { big: true }, 'no_big_variant'],
      ['no count when there is nothing to refill', { count: undefined }, 'no_count'],
      ['no place to plant', { area: undefined }, 'no_area'],
      ['an area that is too large', { area: rect(0, 0, 100, 100) }, 'invalid_area'],
    ])('%s', async (_name, over, reason) => {
      const s = await setup()

      const result = await s.skill.run(input(over), skillContext().context)

      expect(result).toMatchObject({ ok: false, error: { reason } })
    })

    it('a farm that is not a grove', async () => {
      const s = await setup()
      s.farms.register({ kind: 'field', bounds: rect(0, 0, 4, 4), label: 'wheat' })

      const result = await s.skill.run(input({ farm: 'wheat' }), skillContext().context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'not_a_grove' } })
    })

    it('an area where nothing fits, saying why', async () => {
      const s = await setup()
      s.world.ground(0, 0, 12, 12, GROUND, 'stone')

      const result = await s.skill.run(input(), skillContext().context)

      expect(result).toMatchObject({
        ok: false,
        error: { reason: 'no_spots', message: expect.stringContaining('not_plantable_ground') },
      })
    })
  })
})
