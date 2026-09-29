import { describe, expect, it } from '@jest/globals'
import type { NavigationFailure, Navigator } from '../../../../src/core/navigator.port.js'
import type { PlaceFailure, Placer } from '../../../../src/core/placer.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { err, ok, type Result } from '../../../../src/core/result.js'
import type { TillFailure, Tiller } from '../../../../src/core/tiller.port.js'
import { PlantCropsSkill } from '../../../../src/skills/farming/plant-crops-skill.js'
import { FarmRegistry } from '../../../../src/state/farm-registry.js'
import { FakeBlockScanner } from '../../../fakes/fake-ports.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`
const context = () => ({ signal: new AbortController().signal, progress: () => undefined })

class AutoNavigator implements Navigator {
  readonly calls: Position[] = []
  fail: NavigationFailure | undefined
  goToPosition(target: Position): Promise<Result<Position, NavigationFailure>> {
    this.calls.push(target)
    return Promise.resolve(this.fail === undefined ? ok(target) : err(this.fail))
  }
  goToPlayer(): Promise<Result<Position, NavigationFailure>> {
    return Promise.resolve(ok({ x: 0, y: 0, z: 0 }))
  }
  follow(): Promise<Result<void, NavigationFailure>> {
    return Promise.resolve(ok(undefined))
  }
}

class FakeTiller implements Tiller {
  readonly calls: Position[] = []
  failure: TillFailure | undefined
  constructor(private readonly blocks: FakeBlockScanner) {}
  till(position: Position): Promise<Result<void, TillFailure>> {
    this.calls.push(position)
    if (this.failure !== undefined) return Promise.resolve(err(this.failure))
    this.blocks.blockNames.set(key(position), 'farmland')
    return Promise.resolve(ok(undefined))
  }
}

class FakePlacer implements Placer {
  readonly placed: { item: string; at: Position }[] = []
  failure: PlaceFailure | undefined
  constructor(private readonly blocks: FakeBlockScanner) {}
  placeAt(itemName: string, target: Position): Promise<Result<void, PlaceFailure>> {
    this.placed.push({ item: itemName, at: target })
    if (this.failure !== undefined) return Promise.resolve(err(this.failure))
    // The crop stands in the cell afterwards, as in the world (a later sweep must find the plot taken).
    this.blocks.blockNames.set(key(target), 'wheat')
    return Promise.resolve(ok(undefined))
  }
  placeAgainst(): Promise<Result<void, PlaceFailure>> {
    return Promise.resolve(ok(undefined))
  }
}

function setup() {
  const blocks = new FakeBlockScanner()
  const navigator = new AutoNavigator()
  const tiller = new FakeTiller(blocks)
  const placer = new FakePlacer(blocks)
  const farms = new FarmRegistry(new FakeClock(0))
  const skill = new PlantCropsSkill({ blocks, navigator, tiller, placer, farms })
  return { blocks, navigator, tiller, placer, farms, skill }
}

const area = { from: { x: 0, y: 64, z: 0 }, to: { x: 1, y: 64, z: 0 } }

describe('PlantCropsSkill', () => {
  it('tills dirt and plants on every free plot, skipping farmland it does not need to till', async () => {
    const s = setup()
    s.blocks.blockNames.set(key({ x: 0, y: 64, z: 0 }), 'dirt')
    s.blocks.blockNames.set(key({ x: 1, y: 64, z: 0 }), 'farmland')

    const result = await s.skill.run(
      { farm: undefined, area, crop: 'wheat', maxPlants: undefined },
      context(),
    )

    expect(result).toEqual({
      ok: true,
      value: { planted: 2, tilled: 1, skipped: 0, repaired: 0, stillBare: 0 },
    })
    expect(s.tiller.calls).toEqual([{ x: 0, y: 64, z: 0 }])
    expect(s.placer.placed).toEqual([
      { item: 'wheat_seeds', at: { x: 0, y: 65, z: 0 } },
      { item: 'wheat_seeds', at: { x: 1, y: 65, z: 0 } },
    ])
  })

  it('skips a plot that already has something growing above it', async () => {
    const s = setup()
    s.blocks.blockNames.set(key({ x: 0, y: 64, z: 0 }), 'farmland')
    s.blocks.blockNames.set(key({ x: 0, y: 65, z: 0 }), 'wheat')
    s.blocks.blockNames.set(key({ x: 1, y: 64, z: 0 }), 'farmland')

    const result = await s.skill.run(
      { farm: undefined, area, crop: 'wheat', maxPlants: undefined },
      context(),
    )

    expect(result).toEqual({
      ok: true,
      value: { planted: 1, tilled: 0, skipped: 1, repaired: 0, stillBare: 0 },
    })
  })

  it('skips a plot that is neither farmland nor tillable', async () => {
    const s = setup()
    s.blocks.blockNames.set(key({ x: 0, y: 64, z: 0 }), 'stone')
    s.blocks.blockNames.set(key({ x: 1, y: 64, z: 0 }), 'farmland')

    const result = await s.skill.run(
      { farm: undefined, area, crop: 'wheat', maxPlants: undefined },
      context(),
    )

    expect(result).toEqual({
      ok: true,
      value: { planted: 1, tilled: 0, skipped: 1, repaired: 0, stillBare: 0 },
    })
  })

  it('stops after max_plants', async () => {
    const s = setup()
    s.blocks.blockNames.set(key({ x: 0, y: 64, z: 0 }), 'farmland')
    s.blocks.blockNames.set(key({ x: 1, y: 64, z: 0 }), 'farmland')

    const result = await s.skill.run(
      { farm: undefined, area, crop: 'wheat', maxPlants: 1 },
      context(),
    )

    expect(result).toEqual({
      ok: true,
      value: { planted: 1, tilled: 0, skipped: 0, repaired: 0, stillBare: 0 },
    })
  })

  it('fails with no_hoe when tilling fails for want of a hoe', async () => {
    const s = setup()
    s.blocks.blockNames.set(key({ x: 0, y: 64, z: 0 }), 'dirt')
    s.tiller.failure = { reason: 'no_hoe', message: 'no hoe' }

    const result = await s.skill.run(
      {
        farm: undefined,
        area: { from: area.from, to: area.from },
        crop: 'wheat',
        maxPlants: undefined,
      },
      context(),
    )

    expect(result).toEqual({
      ok: false,
      error: { reason: 'no_hoe', message: 'The bot has no hoe to till with.' },
    })
  })

  it('fails with no_seeds when the bot runs out', async () => {
    const s = setup()
    s.blocks.blockNames.set(key({ x: 0, y: 64, z: 0 }), 'farmland')
    s.placer.failure = { reason: 'no_item', message: 'none' }

    const result = await s.skill.run(
      {
        farm: undefined,
        area: { from: area.from, to: area.from },
        crop: 'wheat',
        maxPlants: undefined,
      },
      context(),
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_seeds' } })
  })

  it('rejects an unknown crop', async () => {
    const s = setup()

    const result = await s.skill.run(
      { farm: undefined, area, crop: 'nonsense', maxPlants: undefined },
      context(),
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'unknown_crop' } })
  })

  it('resolves the area from a registered farm', async () => {
    const s = setup()
    await s.farms.attach(new InMemoryStateStore())
    const entry = s.farms.register({ kind: 'field', bounds: area, label: 'wheat field' })
    if (!entry.ok) throw new Error(entry.error)
    s.blocks.blockNames.set(key({ x: 0, y: 64, z: 0 }), 'farmland')
    s.blocks.blockNames.set(key({ x: 1, y: 64, z: 0 }), 'farmland')

    const result = await s.skill.run(
      { farm: 'wheat field', area: undefined, crop: 'wheat', maxPlants: undefined },
      context(),
    )

    expect(result).toEqual({
      ok: true,
      value: { planted: 2, tilled: 0, skipped: 0, repaired: 0, stillBare: 0 },
    })
  })

  it('fails with no_area when neither a farm nor an area is given', async () => {
    const s = setup()

    const result = await s.skill.run(
      { farm: undefined, area: undefined, crop: 'wheat', maxPlants: undefined },
      context(),
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_area' } })
  })

  describe('plots lost while planting', () => {
    it('plants again a plot that was trampled back to dirt during the run, in a later sweep', async () => {
      const s = setup()
      const three = { from: { x: 0, y: 64, z: 0 }, to: { x: 2, y: 64, z: 0 } }
      for (const x of [0, 1, 2]) s.blocks.blockNames.set(key({ x, y: 64, z: 0 }), 'farmland')
      const place = s.placer.placeAt.bind(s.placer)
      let trampled = false
      s.placer.placeAt = async (item, target) => {
        const result = await place(item, target)
        // Planting the last plot: the bot's crossing has turned the middle one back into dirt, and its crop broke.
        if (!trampled && target.x === 2) {
          trampled = true
          s.blocks.blockNames.set(key({ x: 1, y: 64, z: 0 }), 'dirt')
          s.blocks.blockNames.set(key({ x: 1, y: 65, z: 0 }), 'air')
        }
        return result
      }

      const result = await s.skill.run(
        { farm: undefined, area: three, crop: 'wheat', maxPlants: undefined },
        context(),
      )

      expect(result).toEqual({
        ok: true,
        value: { planted: 4, tilled: 1, skipped: 0, repaired: 1, stillBare: 0 },
      })
      expect(s.tiller.calls).toEqual([{ x: 1, y: 64, z: 0 }])
      expect(s.blocks.blockNames.get(key({ x: 1, y: 65, z: 0 }))).toBe('wheat')
    })

    it('stops after three sweeps even when the ground keeps being lost', async () => {
      const s = setup()
      s.blocks.blockNames.set(key({ x: 0, y: 64, z: 0 }), 'farmland')
      const place = s.placer.placeAt.bind(s.placer)
      s.placer.placeAt = async (item, target) => {
        const result = await place(item, target)
        s.blocks.blockNames.set(key(target), 'air')
        return result
      }

      const result = await s.skill.run(
        {
          farm: undefined,
          area: { from: area.from, to: area.from },
          crop: 'wheat',
          maxPlants: undefined,
        },
        context(),
      )

      expect(result).toEqual({
        ok: true,
        value: { planted: 3, tilled: 0, skipped: 0, repaired: 2, stillBare: 1 },
      })
    })

    it('reports the plots it could not reach as still bare, from the final check', async () => {
      const s = setup()
      for (const x of [0, 1]) {
        s.blocks.blockNames.set(key({ x, y: 64, z: 0 }), 'farmland')
        s.blocks.blockNames.set(key({ x, y: 65, z: 0 }), 'air') // loaded and empty, as the world reports it
      }
      s.navigator.fail = { reason: 'unreachable', message: 'no path' }

      const result = await s.skill.run(
        { farm: undefined, area, crop: 'wheat', maxPlants: undefined },
        context(),
      )

      expect(result).toEqual({
        ok: true,
        value: { planted: 0, tilled: 0, skipped: 2, repaired: 0, stillBare: 2 },
      })
    })

    it('finds nothing bare on a field that is fully planted, and ignores water and non-soil blocks', async () => {
      const s = setup()
      const row = { from: { x: 0, y: 64, z: 0 }, to: { x: 3, y: 64, z: 0 } }
      s.blocks.blockNames.set(key({ x: 0, y: 64, z: 0 }), 'farmland')
      s.blocks.blockNames.set(key({ x: 1, y: 64, z: 0 }), 'water')
      s.blocks.blockNames.set(key({ x: 2, y: 64, z: 0 }), 'stone')
      s.blocks.blockNames.set(key({ x: 3, y: 64, z: 0 }), 'farmland')
      s.blocks.blockNames.set(key({ x: 3, y: 65, z: 0 }), 'wheat')

      const result = await s.skill.run(
        { farm: undefined, area: row, crop: 'wheat', maxPlants: undefined },
        context(),
      )

      expect(result).toMatchObject({ ok: true, value: { planted: 1, repaired: 0, stillBare: 0 } })
    })

    it('counts max_plants across the sweeps', async () => {
      const s = setup()
      for (const x of [0, 1]) s.blocks.blockNames.set(key({ x, y: 64, z: 0 }), 'farmland')

      const result = await s.skill.run(
        { farm: undefined, area, crop: 'wheat', maxPlants: 1 },
        context(),
      )

      expect(result).toEqual({
        ok: true,
        value: { planted: 1, tilled: 0, skipped: 0, repaired: 0, stillBare: 0 },
      })
    })
  })
  describe('a pumpkin field', () => {
    // Rows 0 and 2 were tilled by the field; row 1 was left free for the pumpkins. Row 0 also holds the water column.
    const field = { from: { x: 0, y: 64, z: 0 }, to: { x: 2, y: 64, z: 2 } }
    const pumpkinField = () => {
      const s = setup()
      for (const z of [0, 2]) {
        s.blocks.blockNames.set(key({ x: 0, y: 64, z }), 'farmland')
        s.blocks.blockNames.set(key({ x: 1, y: 64, z }), 'water')
        s.blocks.blockNames.set(key({ x: 2, y: 64, z }), 'farmland')
      }
      for (const x of [0, 1, 2]) s.blocks.blockNames.set(key({ x, y: 64, z: 1 }), 'grass_block')
      for (const z of [0, 1, 2])
        for (const x of [0, 1, 2]) s.blocks.blockNames.set(key({ x, y: 65, z }), 'air')
      return s
    }

    it('plants pumpkin_seeds only in the tilled rows and never in the free row', async () => {
      const s = pumpkinField()

      const result = await s.skill.run(
        { farm: undefined, area: field, crop: 'pumpkin', maxPlants: undefined },
        context(),
      )

      expect(result).toEqual({
        ok: true,
        value: { planted: 4, tilled: 0, skipped: 2, repaired: 0, stillBare: 0 },
      })
      expect(s.placer.placed.map((p) => p.item)).toEqual(Array(4).fill('pumpkin_seeds'))
      expect(s.placer.placed.every((p) => p.at.z !== 1)).toBe(true)
      expect(s.tiller.calls).toEqual([])
    })

    it('tills a trampled plot of a stem row again, but never a plot of the free row', async () => {
      const s = pumpkinField()
      s.blocks.blockNames.set(key({ x: 2, y: 64, z: 2 }), 'dirt')

      const result = await s.skill.run(
        { farm: undefined, area: field, crop: 'pumpkin', maxPlants: undefined },
        context(),
      )

      expect(result).toMatchObject({ ok: true, value: { planted: 4, tilled: 1 } })
      expect(s.tiller.calls).toEqual([{ x: 2, y: 64, z: 2 }])
    })

    it('does not call the free row bare in the final check', async () => {
      const s = pumpkinField()
      s.placer.failure = { reason: 'failed', message: 'no' }

      const result = await s.skill.run(
        { farm: undefined, area: field, crop: 'pumpkin', maxPlants: undefined },
        context(),
      )

      expect(result).toMatchObject({ ok: true, value: { planted: 0, stillBare: 4 } })
    })

    it('explains where pumpkin seeds come from when there are none', async () => {
      const s = pumpkinField()
      s.placer.failure = { reason: 'no_item', message: 'none' }

      const result = await s.skill.run(
        { farm: undefined, area: field, crop: 'pumpkin', maxPlants: undefined },
        context(),
      )

      expect(result).toMatchObject({
        ok: false,
        error: { reason: 'no_seeds', message: expect.stringContaining('Craft a pumpkin') },
      })
    })
  })
})
