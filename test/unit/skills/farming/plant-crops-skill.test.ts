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
  placeAt(itemName: string, target: Position): Promise<Result<void, PlaceFailure>> {
    this.placed.push({ item: itemName, at: target })
    return Promise.resolve(this.failure === undefined ? ok(undefined) : err(this.failure))
  }
  placeAgainst(): Promise<Result<void, PlaceFailure>> {
    return Promise.resolve(ok(undefined))
  }
}

function setup() {
  const blocks = new FakeBlockScanner()
  const navigator = new AutoNavigator()
  const tiller = new FakeTiller(blocks)
  const placer = new FakePlacer()
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

    const result = await s.skill.run({ farm: undefined, area, crop: 'wheat', maxPlants: undefined }, context())

    expect(result).toEqual({ ok: true, value: { planted: 2, tilled: 1, skipped: 0 } })
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

    const result = await s.skill.run({ farm: undefined, area, crop: 'wheat', maxPlants: undefined }, context())

    expect(result).toEqual({ ok: true, value: { planted: 1, tilled: 0, skipped: 1 } })
  })

  it('skips a plot that is neither farmland nor tillable', async () => {
    const s = setup()
    s.blocks.blockNames.set(key({ x: 0, y: 64, z: 0 }), 'stone')
    s.blocks.blockNames.set(key({ x: 1, y: 64, z: 0 }), 'farmland')

    const result = await s.skill.run({ farm: undefined, area, crop: 'wheat', maxPlants: undefined }, context())

    expect(result).toEqual({ ok: true, value: { planted: 1, tilled: 0, skipped: 1 } })
  })

  it('stops after max_plants', async () => {
    const s = setup()
    s.blocks.blockNames.set(key({ x: 0, y: 64, z: 0 }), 'farmland')
    s.blocks.blockNames.set(key({ x: 1, y: 64, z: 0 }), 'farmland')

    const result = await s.skill.run({ farm: undefined, area, crop: 'wheat', maxPlants: 1 }, context())

    expect(result).toEqual({ ok: true, value: { planted: 1, tilled: 0, skipped: 0 } })
  })

  it('fails with no_hoe when tilling fails for want of a hoe', async () => {
    const s = setup()
    s.blocks.blockNames.set(key({ x: 0, y: 64, z: 0 }), 'dirt')
    s.tiller.failure = { reason: 'no_hoe', message: 'no hoe' }

    const result = await s.skill.run(
      { farm: undefined, area: { from: area.from, to: area.from }, crop: 'wheat', maxPlants: undefined },
      context(),
    )

    expect(result).toEqual({ ok: false, error: { reason: 'no_hoe', message: 'The bot has no hoe to till with.' } })
  })

  it('fails with no_seeds when the bot runs out', async () => {
    const s = setup()
    s.blocks.blockNames.set(key({ x: 0, y: 64, z: 0 }), 'farmland')
    s.placer.failure = { reason: 'no_item', message: 'none' }

    const result = await s.skill.run(
      { farm: undefined, area: { from: area.from, to: area.from }, crop: 'wheat', maxPlants: undefined },
      context(),
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_seeds' } })
  })

  it('rejects an unknown crop', async () => {
    const s = setup()

    const result = await s.skill.run({ farm: undefined, area, crop: 'nonsense', maxPlants: undefined }, context())

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

    expect(result).toEqual({ ok: true, value: { planted: 2, tilled: 0, skipped: 0 } })
  })

  it('fails with no_area when neither a farm nor an area is given', async () => {
    const s = setup()

    const result = await s.skill.run({ farm: undefined, area: undefined, crop: 'wheat', maxPlants: undefined }, context())

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_area' } })
  })
})
