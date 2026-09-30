import { describe, expect, it } from '@jest/globals'
import type { AnimalInfo, AnimalScanner } from '../../../../src/core/animal-scanner.port.js'
import type { BlockUser } from '../../../../src/core/block-user.port.js'
import type { CampfireAccess, CampfireState } from '../../../../src/core/campfire.port.js'
import type { HiveAccess } from '../../../../src/core/hive.port.js'
import type { PlaceFailure, Placer } from '../../../../src/core/placer.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { err, ok, type Result } from '../../../../src/core/result.js'
import { HarvestHoneySkill } from '../../../../src/skills/farming/harvest-honey-skill.js'
import { InspectHivesSkill } from '../../../../src/skills/farming/inspect-hives-skill.js'
import { ApiaryProvider } from '../../../../src/skills/farming/providers/apiary.js'
import { FarmRegistry } from '../../../../src/state/farm-registry.js'
import { Bag } from '../../../fakes/bag-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeBlockScanner, FakeVitals, buildVitals } from '../../../fakes/fake-ports.js'
import {
  AutoScheduler,
  FakeAreaGuard,
  InstantNavigator,
  skillContext,
} from '../../../fakes/gathering-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`
const HIVE = { x: 5, y: 66, z: 0 }

/** A little world: hives with honey levels, campfires, bees, and the bag; clicks on a full hive empty it. */
class World implements BlockUser, Placer {
  readonly levels = new Map<string, number>()
  readonly campfires = new Map<string, CampfireState>()
  readonly placed: Position[] = []
  ignoreClicks = false
  /** Bees go angry after a hive was harvested. */
  angerAfterHarvest = false
  animals: AnimalInfo[] = []
  readonly bag: Bag
  readonly scanner = new FakeBlockScanner()

  constructor(items: Record<string, number>) {
    this.bag = new Bag(items)
  }

  addHive(position: Position, level: number): void {
    this.levels.set(key(position), level)
    this.scanner.blockNames.set(key(position), 'beehive')
    this.scanner.blocks = [
      ...this.scanner.blocks,
      { name: 'beehive', position, distance: Math.abs(position.x) + 1 },
    ]
  }
  addCampfire(position: Position, state: CampfireState = 'lit'): void {
    this.campfires.set(key(position), state)
    this.scanner.blockNames.set(key(position), 'campfire')
  }
  ground(x: number, z: number, top: number): void {
    for (let y = top - 1; y <= top + 4; y += 1) this.scanner.blockNames.set(key({ x, y, z }), 'air')
    this.scanner.solid.set(key({ x, y: top - 1, z }), true)
  }

  use(position: Position, item: string | undefined): Promise<Result<void>> {
    const level = this.levels.get(key(position)) ?? 0
    if (this.ignoreClicks || level < 5 || item === undefined) return Promise.resolve(ok(undefined))
    this.levels.set(key(position), 0)
    if (item === 'glass_bottle') {
      this.bag.give('glass_bottle', -1)
      this.bag.give('honey_bottle', 1)
    } else if (item === 'shears') this.bag.give('honeycomb', 3)
    if (this.angerAfterHarvest) this.animals = [{ ...bee(1, position), angry: true }]
    return Promise.resolve(ok(undefined))
  }
  placeAt(item: string, target: Position): Promise<Result<void, PlaceFailure>> {
    this.placed.push(target)
    this.bag.give(item, -1)
    this.addCampfire(target)
    return Promise.resolve(ok(undefined))
  }
  placeAgainst(): Promise<Result<void, PlaceFailure>> {
    return Promise.resolve(ok(undefined))
  }
}

// The one object is three ports at once (hive, campfire, animals); these views keep the types honest.
const hiveView = (world: World): HiveAccess => ({
  stateAt: (position) => {
    const level = world.levels.get(key(position))
    return level === undefined ? undefined : { kind: 'hive', honeyLevel: level }
  },
})
const campfireView = (world: World): CampfireAccess => ({
  stateAt: (position) => world.campfires.get(key(position)) ?? 'none',
  put: () => Promise.resolve(err('not used')),
})
const animalView = (world: World): AnimalScanner => ({
  nearby: () => world.animals,
  find: (id) => world.animals.find((a) => a.id === id),
})

const bee = (id: number, position: Position): AnimalInfo => ({
  id,
  species: 'bee',
  position,
  distance: 1,
  baby: false,
  named: false,
  owned: false,
  saddled: false,
  ridden: false,
  dead: false,
})

async function setup(items: Record<string, number>) {
  const world = new World(items)
  world.ground(5, 0, 64)
  const clock = new FakeClock()
  const farms = new FarmRegistry(clock)
  await farms.attach(new InMemoryStateStore())
  const guard = new FakeAreaGuard()
  const vitals = new FakeVitals()
  vitals.vitals = buildVitals({ position: { x: 0.5, y: 64, z: 0.5 } })
  const navigator = new InstantNavigator()
  const inspect = new InspectHivesSkill({
    blocks: world.scanner,
    hives: hiveView(world),
    campfires: campfireView(world),
    guard,
    animals: animalView(world),
    farms,
  })
  const crafted: string[] = []
  const skill = new HarvestHoneySkill({
    inspect,
    blocks: world.scanner,
    hives: hiveView(world),
    campfires: campfireView(world),
    user: world,
    placer: world,
    navigator,
    inventory: world.bag,
    guard,
    animals: animalView(world),
    farms,
    vitals,
    scheduler: new AutoScheduler(clock),
    crafter: {
      run: (input) => {
        crafted.push(input.item)
        world.bag.give('glass_bottle', input.count)
        return Promise.resolve(
          ok({ item: input.item, produced: input.count, steps: [], placedTable: false }),
        )
      },
    },
  })
  return { world, skill, inspect, farms, guard, navigator, crafted }
}

const honey = {
  what: 'honey' as const,
  farm: undefined,
  at: undefined,
  radius: 24,
  count: undefined,
  smoke: 'auto' as const,
  craftBottles: false,
}

describe('InspectHivesSkill', () => {
  it('reads level, smoke, protection, and the bees near each hive', async () => {
    const { world, inspect, guard } = await setup({})
    world.addHive(HIVE, 5)
    world.addCampfire({ x: 5, y: 64, z: 0 })
    world.addHive({ x: 9, y: 66, z: 0 }, 2)
    guard.protect('camp', (p) => p.x === 9)
    world.animals = [bee(1, { x: 6, y: 66, z: 0 })]
    const { context } = skillContext()

    const result = await inspect.run({ farm: undefined, radius: 32 }, context)

    expect(result).toMatchObject({
      ok: true,
      value: {
        ready: 1,
        hives: [
          { honeyLevel: 5, ready: true, smoked: true, beesNear: 1 },
          { honeyLevel: 2, ready: false, smoked: false, protectedBy: 'camp' },
        ],
      },
    })
  })

  it('does not count an out campfire or one too far below as smoke, and fails for an unknown farm', async () => {
    const { world, inspect } = await setup({})
    world.addHive(HIVE, 5)
    world.addCampfire({ x: 5, y: 64, z: 0 }, 'out')
    const { context } = skillContext()
    expect(await inspect.run({ farm: undefined, radius: 32 }, context)).toMatchObject({
      ok: true,
      value: { hives: [{ smoked: false }] },
    })
    world.campfires.set(key({ x: 5, y: 64, z: 0 }), 'lit')
    world.campfires.delete(key({ x: 5, y: 64, z: 0 }))
    world.addCampfire({ x: 5, y: 59, z: 0 })
    expect(await inspect.run({ farm: undefined, radius: 32 }, context)).toMatchObject({
      value: { hives: [{ smoked: false }] },
    })
    expect(await inspect.run({ farm: 'nope', radius: 32 }, context)).toMatchObject({
      ok: false,
      error: { reason: 'unknown_farm' },
    })
  })
})

describe('HarvestHoneySkill', () => {
  it('harvests a ripe hive that has a lit campfire under it, with a bottle', async () => {
    const { world, skill } = await setup({ glass_bottle: 2 })
    world.addHive(HIVE, 5)
    world.addCampfire({ x: 5, y: 65, z: 0 })
    const { context } = skillContext()

    const result = await skill.run(honey, context)

    expect(result).toEqual({
      ok: true,
      value: {
        honeyBottles: 1,
        honeycomb: 0,
        hives: 1,
        skipped: { notReady: 0, protected: 0, noSmoke: 0, unreachable: 0, noEffect: 0 },
        campfiresPlaced: [],
      },
    })
    expect(world.bag.count('honey_bottle')).toBe(1)
    expect(world.levels.get(key(HIVE))).toBe(0)
  })

  it('places a campfire under a hive that has none, from the bag, before harvesting', async () => {
    const { world, skill } = await setup({ glass_bottle: 1, campfire: 1 })
    world.addHive(HIVE, 5)
    const { context } = skillContext()

    const result = await skill.run(honey, context)

    expect(result).toMatchObject({
      ok: true,
      value: { honeyBottles: 1, campfiresPlaced: [{ x: 5, y: 64, z: 0 }] },
    })
  })

  it('refuses a hive with no smoke and no campfire to place, saying what to do', async () => {
    const { world, skill } = await setup({ glass_bottle: 1 })
    world.addHive(HIVE, 5)
    const { context } = skillContext()

    const result = await skill.run(honey, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_smoke' } })
    expect(world.bag.count('honey_bottle')).toBe(0)
    expect(world.levels.get(key(HIVE))).toBe(5)
  })

  it('goes without smoke only when told to', async () => {
    const { world, skill } = await setup({ glass_bottle: 1 })
    world.addHive(HIVE, 5)
    const { context } = skillContext()

    const result = await skill.run({ ...honey, smoke: 'never' }, context)

    expect(result).toMatchObject({ ok: true, value: { honeyBottles: 1 } })
  })

  it('takes honeycomb with shears', async () => {
    const { world, skill } = await setup({ shears: 1 })
    world.addHive(HIVE, 5)
    world.addCampfire({ x: 5, y: 65, z: 0 })
    const { context } = skillContext()

    const result = await skill.run({ ...honey, what: 'honeycomb' }, context)

    expect(result).toMatchObject({ ok: true, value: { honeycomb: 3, honeyBottles: 0 } })
  })

  it('skips hives that are not ripe or are protected, and stops at count', async () => {
    const { world, skill, guard } = await setup({ glass_bottle: 5 })
    world.addHive({ x: 5, y: 66, z: 0 }, 3)
    world.addHive({ x: 6, y: 66, z: 0 }, 5)
    world.addHive({ x: 7, y: 66, z: 0 }, 5)
    world.addHive({ x: 8, y: 66, z: 0 }, 5)
    for (const x of [5, 6, 7, 8]) world.addCampfire({ x, y: 65, z: 0 })
    guard.protect('theirs', (p) => p.x === 6)
    const { context } = skillContext()

    const result = await skill.run({ ...honey, count: 1 }, context)

    expect(result).toMatchObject({
      ok: true,
      value: { honeyBottles: 1, hives: 1, skipped: { notReady: 1, protected: 1 } },
    })
  })

  it('fails without a bottle or shears, and crafts bottles when allowed', async () => {
    const { world, skill, crafted } = await setup({})
    world.addHive(HIVE, 5)
    world.addCampfire({ x: 5, y: 65, z: 0 })
    const { context } = skillContext()

    expect(await skill.run(honey, context)).toMatchObject({
      ok: false,
      error: { reason: 'no_bottles' },
    })
    expect(await skill.run({ ...honey, what: 'honeycomb' }, context)).toMatchObject({
      ok: false,
      error: { reason: 'no_shears' },
    })
    const made = await skill.run({ ...honey, craftBottles: true }, context)
    expect(made).toMatchObject({ ok: true, value: { honeyBottles: 1 } })
    expect(crafted).toEqual(['glass_bottle'])
  })

  it('does not count a click that did nothing', async () => {
    const { world, skill } = await setup({ glass_bottle: 1 })
    world.addHive(HIVE, 5)
    world.addCampfire({ x: 5, y: 65, z: 0 })
    world.ignoreClicks = true
    const { context } = skillContext()

    const result = await skill.run(honey, context)

    expect(result).toMatchObject({ ok: true, value: { honeyBottles: 0, skipped: { noEffect: 1 } } })
  })

  it('stops at the first angry bee and reports what it had', async () => {
    const { world, skill } = await setup({ glass_bottle: 3 })
    for (const x of [5, 6]) {
      world.addHive({ x, y: 66, z: 0 }, 5)
      world.addCampfire({ x, y: 65, z: 0 })
    }
    world.angerAfterHarvest = true
    const { context } = skillContext()

    const result = await skill.run(honey, context)

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'bees_angry', detail: { honeyBottles: 1, hives: 1 } },
    })
    expect(world.levels.get(key({ x: 6, y: 66, z: 0 }))).toBe(5)
  })

  it('works one hive by position, fails when there is none, and for an unknown farm', async () => {
    const { world, skill } = await setup({ glass_bottle: 1 })
    world.addHive(HIVE, 5)
    world.addCampfire({ x: 5, y: 65, z: 0 })
    const { context } = skillContext()

    expect(await skill.run({ ...honey, at: HIVE }, context)).toMatchObject({
      ok: true,
      value: { hives: 1 },
    })
    expect(await skill.run({ ...honey, at: { x: 1, y: 70, z: 1 } }, context)).toMatchObject({
      ok: false,
      error: { reason: 'no_hive' },
    })
    expect(await skill.run({ ...honey, farm: 'nope' }, context)).toMatchObject({
      ok: false,
      error: { reason: 'unknown_farm' },
    })
  })

  it('stops when cancelled', async () => {
    const { world, skill } = await setup({ glass_bottle: 1 })
    world.addHive(HIVE, 5)
    world.addCampfire({ x: 5, y: 65, z: 0 })
    const { context, controller } = skillContext()
    controller.abort()

    expect(await skill.run(honey, context)).toMatchObject({
      ok: false,
      error: { reason: 'aborted' },
    })
  })

  it('works a registered apiary, including hives in its own protected area', async () => {
    const { world, skill, farms, guard } = await setup({ glass_bottle: 2 })
    world.addHive(HIVE, 5)
    world.addCampfire({ x: 5, y: 65, z: 0 })
    world.addHive({ x: 30, y: 66, z: 0 }, 5) // outside the apiary
    farms.register({
      kind: 'apiary',
      species: 'bee',
      bounds: { from: { x: 4, y: 65, z: -1 }, to: { x: 6, y: 66, z: 2 } },
      label: 'bees',
    })
    guard.protect('bees', (p) => p.x >= 4 && p.x <= 6)
    const { context } = skillContext()

    const result = await skill.run({ ...honey, farm: 'bees' }, context)

    expect(result).toMatchObject({ ok: true, value: { hives: 1, honeyBottles: 1 } })
    expect(world.levels.get(key({ x: 30, y: 66, z: 0 }))).toBe(5)
  })
})

describe('ApiaryProvider', () => {
  const provider = new ApiaryProvider()
  const origin = { x: 0, y: 64, z: 0 }

  it('puts each hive on its campfire, three blocks apart, with a row of flowers', () => {
    const plan = provider.generate(provider.params.parse({ hives: 2 }), { origin })

    expect('error' in plan).toBe(false)
    if ('error' in plan) return
    const places = plan.steps.filter((step) => step.kind === 'place')
    expect(places.filter((s) => s.block === 'beehive').map((s) => s.at)).toEqual([
      { x: 0, y: 66, z: 0 },
      { x: 3, y: 66, z: 0 },
    ])
    expect(places.filter((s) => s.block === 'campfire').map((s) => s.at)).toEqual([
      { x: 0, y: 65, z: 0 },
      { x: 3, y: 65, z: 0 },
    ])
    expect(places.filter((s) => s.block === 'poppy')).toHaveLength(4)
    expect(provider.speciesOf()).toBe('bee')
    expect(provider.defaultOrigin({ x: 3.5, y: 65, z: 2.5 })).toEqual({ x: 5, y: 64, z: 2 })
  })

  it('uses fence posts instead when there is no campfire', () => {
    const plan = provider.generate(
      provider.params.parse({ hives: 1, campfire: false, flower: 'dandelion' }),
      { origin },
    )

    if ('error' in plan) throw new Error(plan.error)
    const blocks = plan.steps.filter((s) => s.kind === 'place').map((s) => s.block)
    expect(blocks).toContain('oak_fence')
    expect(blocks).not.toContain('campfire')
    expect(blocks).toContain('dandelion')
  })
})
