import { describe, expect, it } from '@jest/globals'
import type { NavigationFailure, Navigator } from '../../../../src/core/navigator.port.js'
import type { PlaceFailure, Placer } from '../../../../src/core/placer.port.js'
import type { TillFailure, Tiller } from '../../../../src/core/tiller.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { err, ok, type Result } from '../../../../src/core/result.js'
import { BuildFarmSkill } from '../../../../src/skills/farming/build-farm-skill.js'
import { FarmLayoutRegistry } from '../../../../src/skills/farming/farm-layout-registry.js'
import { PlantCropsSkill } from '../../../../src/skills/farming/plant-crops-skill.js'
import { CropFieldProvider } from '../../../../src/skills/farming/providers/crop-field.js'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import { PlanExecutor } from '../../../../src/skills/construction/plan-executor.js'
import { SiteSafety } from '../../../../src/skills/construction/site-safety.js'
import { StandingSpotChooser } from '../../../../src/skills/construction/standing-spot.js'
import { FarmRegistry } from '../../../../src/state/farm-registry.js'
import { ProtectedAreas } from '../../../../src/state/protected-areas.js'
import { ConstructionWorld } from '../../../fakes/construction-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { AutoScheduler, FakeDroppedItems, skillContext } from '../../../fakes/gathering-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

class FakeTiller implements Tiller {
  constructor(private readonly world: ConstructionWorld) {}
  till(position: Position, _signal: AbortSignal): Promise<Result<void, TillFailure>> {
    this.world.setBlock(position, 'farmland')
    return Promise.resolve(ok(undefined))
  }
}

/**
 * A simple navigator that approaches without landing exactly on the target (unlike `ConstructionWorld`'s own
 * navigator, which teleports straight onto it): real Mineflayer stops short by `within`, and `plant_crops` relies
 * on that to avoid the bot's own head colliding with the seed it is about to place one block above the plot.
 */
class ApproachingNavigator implements Navigator {
  goToPosition(target: Position, within: number): Promise<Result<Position, NavigationFailure>> {
    return Promise.resolve(ok({ x: target.x, y: target.y, z: target.z - within }))
  }
  goToPlayer(): Promise<Result<Position, NavigationFailure>> {
    return Promise.resolve(ok({ x: 0, y: 0, z: 0 }))
  }
  follow(): Promise<Result<void, NavigationFailure>> {
    return Promise.resolve(ok(undefined))
  }
}

class FakeSeedPlacer implements Placer {
  constructor(private readonly world: ConstructionWorld) {}
  placeAt(itemName: string, target: Position): Promise<Result<void, PlaceFailure>> {
    if ((this.world.carried.get(itemName) ?? 0) <= 0)
      return Promise.resolve(err({ reason: 'no_item', message: `No ${itemName}.` }))
    this.world.give(itemName, -1)
    this.world.setBlock(target, itemName === 'wheat_seeds' ? 'wheat' : itemName)
    return Promise.resolve(ok(undefined))
  }
  placeAgainst(): Promise<Result<void, PlaceFailure>> {
    return Promise.resolve(ok(undefined))
  }
}

async function setup() {
  const world = new ConstructionWorld()
  const clock = new FakeClock(Date.UTC(2026, 8, 19, 12))
  const scheduler = new AutoScheduler(clock)
  const drops = new DropCollector({ drops: new FakeDroppedItems(), navigator: world, scheduler })
  const executor = new PlanExecutor({
    blocks: world,
    placer: world,
    digger: world,
    navigator: world,
    inventory: world,
    vitals: world,
    guard: world,
    drops,
    spots: new StandingSpotChooser(world),
    safety: new SiteSafety(world, world),
    scheduler,
    tiller: new FakeTiller(world),
  })
  const registry = new FarmLayoutRegistry().register(new CropFieldProvider())
  const farms = new FarmRegistry(clock)
  await farms.attach(new InMemoryStateStore())
  const protectedAreas = new ProtectedAreas()
  await protectedAreas.attach(new InMemoryStateStore())
  const tiller = new FakeTiller(world)
  const plant = new PlantCropsSkill({
    blocks: world,
    navigator: new ApproachingNavigator(),
    tiller,
    placer: new FakeSeedPlacer(world),
    farms,
  })
  const skill = new BuildFarmSkill({ registry, executor, vitals: world, farms, protectedAreas, plant })
  return { world, skill, farms, protectedAreas }
}

describe('BuildFarmSkill', () => {
  it('builds a field, registers it, and protects its footprint', async () => {
    const s = await setup()
    s.world.give('wheat_seeds', 8)
    s.world.give('water_bucket', 1)

    const result = await s.skill.run(
      {
        kind: 'field',
        params: { width: 3, length: 3, crop: 'wheat', fence: false, torches: false },
        origin: { x: 0, y: 63, z: 0 },
        label: 'wheat field',
        group: 'home',
        fetchFromStorage: false,
      },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.value.farm).toMatchObject({
      kind: 'field',
      crop: 'wheat',
      label: 'wheat field',
      group: 'home',
      builtByBot: true,
    })
    expect(result.value.protectedArea).toBe(true)
    expect(result.value.planted).toBe(8) // every interior plot but the water channel
    expect(s.farms.all()).toHaveLength(1)
    expect(s.protectedAreas.list()).toMatchObject({ ok: true, value: [{ label: 'wheat field' }] })
    expect(s.world.blockAt({ x: 0, y: 63, z: 0 })).toBe('farmland')
    expect(s.world.blockAt({ x: 0, y: 64, z: 0 })).toBe('wheat')
  })

  it('fails with missing_materials and lists what is missing when nothing is fetched', async () => {
    const s = await setup()

    const result = await s.skill.run(
      {
        kind: 'field',
        params: { width: 3, length: 3, crop: 'wheat', fence: false, torches: false },
        origin: { x: 0, y: 63, z: 0 },
        fetchFromStorage: false,
      },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'missing_materials' } })
    expect(s.farms.all()).toHaveLength(0)
  })

  it('rejects an unknown farm kind', async () => {
    const s = await setup()

    const result = await s.skill.run(
      { kind: 'pen', params: {}, origin: undefined, fetchFromStorage: false },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'unknown_kind' } })
  })

  it('previews without changing anything', async () => {
    const s = await setup()

    const preview = s.skill.preview({
      kind: 'field',
      params: { width: 3, length: 3, crop: 'wheat', fence: false, torches: false },
      origin: { x: 0, y: 63, z: 0 },
      fetchFromStorage: false,
    })

    expect(preview).toMatchObject({ ok: true, value: { defaultOrigin: false } })
    expect(s.farms.all()).toHaveLength(0)
    expect(s.world.blockAt({ x: 0, y: 63, z: 0 })).not.toBe('farmland')
  })
})
