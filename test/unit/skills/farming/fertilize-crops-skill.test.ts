import { describe, expect, it } from '@jest/globals'
import type { BlockUser } from '../../../../src/core/block-user.port.js'
import type { CropAccess, CropState } from '../../../../src/core/crop.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { err, ok, type Result } from '../../../../src/core/result.js'
import type {
  BoneMealOutcome,
  BoneMealSources,
  BoneMealSupplier,
} from '../../../../src/skills/farming/bone-meal-supply.js'
import { FertilizeCropsSkill } from '../../../../src/skills/farming/fertilize-crops-skill.js'
import { FarmRegistry } from '../../../../src/state/farm-registry.js'
import { Bag } from '../../../fakes/bag-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeVitals, buildVitals } from '../../../fakes/fake-ports.js'
import {
  AutoScheduler,
  FakeAreaGuard,
  InstantNavigator,
  skillContext,
} from '../../../fakes/gathering-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`
const FIELD = { from: { x: 0, y: 64, z: 0 }, to: { x: 3, y: 64, z: 0 } }

/** Crops at y 65 over x 0..3, each growing by the next number in `growth` per bone meal used on it. */
class Crops implements CropAccess, BlockUser {
  readonly crops = new Map<string, CropState>()
  readonly used: Position[] = []
  /** How many stages a use adds, in turn (then the last value repeats). */
  growth: number[] = [2]
  private uses = 0
  failUse = false

  constructor(private readonly bag: Bag) {}

  plant(x: number, name: string, age: number): void {
    this.crops.set(key({ x, y: 65, z: 0 }), { name, age })
  }
  age(x: number): number | undefined {
    return this.crops.get(key({ x, y: 65, z: 0 }))?.age
  }
  stateAt(position: Position): CropState | undefined {
    return this.crops.get(key(position))
  }
  use(position: Position, item: string | undefined): Promise<Result<void>> {
    if (this.failUse) return Promise.resolve(err('out of reach'))
    if (item !== 'bone_meal' || this.bag.count('bone_meal') === 0)
      return Promise.resolve(err('no bone meal'))
    this.bag.give('bone_meal', -1)
    this.used.push(position)
    const crop = this.crops.get(key(position))
    const step = this.growth[Math.min(this.uses, this.growth.length - 1)] ?? 0
    this.uses += 1
    if (crop !== undefined)
      this.crops.set(key(position), { ...crop, age: Math.min(7, crop.age + step) })
    return Promise.resolve(ok(undefined))
  }
}

class Supply implements BoneMealSupplier {
  readonly asked: { wanted: number; sources: BoneMealSources }[] = []
  /** What the supply adds to the bag when asked. */
  adds = 0
  constructor(private readonly bag: Bag) {}
  ensure(wanted: number, sources: BoneMealSources): Promise<BoneMealOutcome> {
    this.asked.push({ wanted, sources })
    this.bag.give('bone_meal', this.adds)
    return Promise.resolve({ have: this.bag.count('bone_meal'), fetched: this.adds, crafted: 0 })
  }
}

async function setup(boneMeal: number) {
  const bag = new Bag({ bone_meal: boneMeal })
  const crops = new Crops(bag)
  const supply = new Supply(bag)
  const clock = new FakeClock()
  const farms = new FarmRegistry(clock)
  await farms.attach(new InMemoryStateStore())
  const guard = new FakeAreaGuard()
  const vitals = new FakeVitals()
  vitals.vitals = buildVitals({ position: { x: 0.5, y: 65, z: 0.5 } })
  const navigator = new InstantNavigator()
  const skill = new FertilizeCropsSkill({
    crops,
    navigator,
    user: crops,
    inventory: bag,
    farms,
    guard,
    vitals,
    scheduler: new AutoScheduler(clock),
    supply,
  })
  return { bag, crops, supply, farms, guard, skill, navigator }
}

const input = {
  farm: undefined,
  area: FIELD,
  crop: undefined,
  stages: undefined,
  maxBoneMeal: undefined,
  sources: { fromStorage: false, craft: false },
}

describe('FertilizeCropsSkill', () => {
  it('ripens the unripe crops, leaves the ripe ones alone, and reports the bone meal used', async () => {
    const { skill, crops, bag } = await setup(20)
    crops.plant(0, 'wheat', 0)
    crops.plant(1, 'wheat', 7)
    crops.plant(2, 'carrots', 3)
    const { context } = skillContext()

    const result = await skill.run(input, context)

    expect(result).toEqual({
      ok: true,
      value: {
        applied: 6, // wheat 0 -> 7 takes four uses of +2, carrots 3 -> 7 takes two
        ripened: 2,
        skipped: { protected: 0, unreachable: 0, alreadyRipe: 1 },
        boneMealLeft: 14,
      },
    })
    expect([crops.age(0), crops.age(1), crops.age(2)]).toEqual([7, 7, 7])
    expect(bag.count('bone_meal')).toBe(14)
  })

  it('retries a use that did not grow the plant, and stops at ripe', async () => {
    const { skill, crops } = await setup(10)
    crops.plant(0, 'wheat', 5)
    crops.growth = [0, 0, 3]
    const { context } = skillContext()

    const result = await skill.run(input, context)

    expect(result).toMatchObject({ ok: true, value: { applied: 3, ripened: 1 } })
  })

  it('grows a crop only `stages` stages', async () => {
    const { skill, crops } = await setup(10)
    crops.plant(0, 'wheat', 0)
    crops.growth = [1]
    const { context } = skillContext()

    const result = await skill.run({ ...input, stages: 3 }, context)

    expect(result).toMatchObject({ ok: true, value: { applied: 3, ripened: 0 } })
    expect(crops.age(0)).toBe(3)
  })

  it('never uses more than max_bone_meal', async () => {
    const { skill, crops, bag } = await setup(20)
    for (const x of [0, 1, 2, 3]) crops.plant(x, 'wheat', 0)
    crops.growth = [1]
    const { context } = skillContext()

    const result = await skill.run({ ...input, maxBoneMeal: 5 }, context)

    expect(result).toMatchObject({ ok: true, value: { applied: 5 } })
    expect(bag.count('bone_meal')).toBe(15)
  })

  it('only takes the crop asked for', async () => {
    const { skill, crops } = await setup(20)
    crops.plant(0, 'wheat', 0)
    crops.plant(1, 'carrots', 0)
    const { context } = skillContext()

    await skill.run({ ...input, crop: 'carrots' }, context)

    expect(crops.age(0)).toBe(0)
    expect(crops.age(1)).toBe(7)
  })

  it('grows the stem of a stem crop and skips an attached stem (no age) and its fruit', async () => {
    const { skill, crops } = await setup(20)
    crops.plant(0, 'pumpkin_stem', 2)
    const { context } = skillContext()

    const result = await skill.run(input, context)

    expect(result).toMatchObject({ ok: true, value: { ripened: 1 } })
    expect(crops.age(0)).toBe(7)
  })

  it("skips protected cells that are not the field's own, and says so", async () => {
    const { skill, crops, guard, farms } = await setup(20)
    farms.register({ kind: 'field', crop: 'wheat', bounds: FIELD, label: 'mine' })
    crops.plant(0, 'wheat', 0)
    crops.plant(1, 'wheat', 0)
    guard.protect('mine', () => true)
    guard.protect('someone else', (p) => p.x === 1)
    const { context } = skillContext()

    const own = await skill.run({ ...input, area: undefined, farm: 'mine' }, context)

    expect(own).toMatchObject({ ok: true, value: { ripened: 2, skipped: { protected: 0 } } })
  })

  it("leaves a cell in someone else's protected area alone", async () => {
    const { skill, crops, guard } = await setup(20)
    crops.plant(0, 'wheat', 0)
    guard.protect('someone else', () => true)
    const { context } = skillContext()

    const result = await skill.run(input, context)

    expect(result).toMatchObject({ ok: true, value: { applied: 0, skipped: { protected: 1 } } })
  })

  it('asks the supply when the bag has too little, and fails missing_bone_meal when nothing comes', async () => {
    const { skill, crops, supply } = await setup(0)
    crops.plant(0, 'wheat', 0)
    crops.plant(1, 'wheat', 0)
    const { context } = skillContext()

    const none = await skill.run({ ...input, sources: { fromStorage: true, craft: true } }, context)

    expect(none).toMatchObject({ ok: false, error: { reason: 'missing_bone_meal' } })
    expect(supply.asked).toEqual([{ wanted: 2, sources: { fromStorage: true, craft: true } }])

    supply.adds = 10
    const some = await skill.run(input, context)
    expect(some).toMatchObject({ ok: true, value: { ripened: 2 } })
  })

  it('reports unreachable plants and stops when the use itself fails', async () => {
    const { skill, crops } = await setup(10)
    crops.plant(0, 'wheat', 0)
    crops.failUse = true
    const { context } = skillContext()

    const result = await skill.run(input, context)

    expect(result).toMatchObject({
      ok: true,
      value: { applied: 0, ripened: 0, skipped: { unreachable: 1 } },
    })
  })

  it('says so when there is nothing to fertilize, and for an unknown farm or no area', async () => {
    const { skill, crops } = await setup(10)
    crops.plant(0, 'wheat', 7)
    const { context } = skillContext()

    expect(await skill.run(input, context)).toMatchObject({
      ok: true,
      value: { applied: 0, skipped: { alreadyRipe: 1 } },
    })
    expect(await skill.run({ ...input, area: undefined, farm: 'nope' }, context)).toMatchObject({
      ok: false,
      error: { reason: 'no_area' },
    })
    expect(await skill.run({ ...input, area: undefined }, context)).toMatchObject({
      ok: false,
      error: { reason: 'no_area' },
    })
  })

  it('stops when cancelled', async () => {
    const { skill, crops } = await setup(10)
    crops.plant(0, 'wheat', 0)
    const { context, controller } = skillContext()
    controller.abort()

    expect(await skill.run(input, context)).toMatchObject({
      ok: false,
      error: { reason: 'aborted' },
    })
  })
})
