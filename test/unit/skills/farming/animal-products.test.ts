import { describe, expect, it } from '@jest/globals'
import type { AnimalInfo, AnimalScanner } from '../../../../src/core/animal-scanner.port.js'
import type {
  AnimalInteraction,
  AnimalInteractionFailure,
} from '../../../../src/core/animal-interaction.port.js'
import type { Navigator } from '../../../../src/core/navigator.port.js'
import { err, ok, type Result } from '../../../../src/core/result.js'
import { productSkip } from '../../../../src/skills/farming/animal-products.js'
import { MilkCowsSkill } from '../../../../src/skills/farming/milk-cows-skill.js'
import { ShearSheepSkill } from '../../../../src/skills/farming/shear-sheep-skill.js'
import { FarmRegistry } from '../../../../src/state/farm-registry.js'
import { penGateSetup } from '../../../fakes/pen-gate-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeInventory } from '../../../fakes/fake-ports.js'
import { AutoScheduler, InstantNavigator, skillContext } from '../../../fakes/gathering-fakes.js'

const animal = (id: number, species: string, overrides: Partial<AnimalInfo> = {}): AnimalInfo => ({
  id,
  species,
  position: { x: id, y: 64, z: 0 },
  distance: id,
  baby: false,
  named: false,
  owned: false,
  saddled: false,
  ridden: false,
  dead: false,
  ...overrides,
})

/** A little world: animals that change when shears or a bucket are used on them, and an inventory that follows. */
class World implements AnimalScanner, AnimalInteraction {
  animals: AnimalInfo[] = []
  held: string | undefined
  readonly used: number[] = []
  /** When true the click does nothing (the server ignored it). */
  ignoreClicks = false
  readonly inventory = new FakeInventory()

  constructor(items: Record<string, number>) {
    this.inventory.value = {
      stacks: Object.entries(items).map(([name, count]) => ({ name, count })),
      emptySlots: 30,
      heldItem: undefined,
    }
  }

  nearby(): readonly AnimalInfo[] {
    return this.animals
  }
  find(id: number): AnimalInfo | undefined {
    return this.animals.find((candidate) => candidate.id === id)
  }
  hold(item: string): Promise<Result<void, AnimalInteractionFailure>> {
    this.held = item
    return Promise.resolve(ok(undefined))
  }
  feed(): Promise<Result<void, AnimalInteractionFailure>> {
    return Promise.resolve(err({ reason: 'failed', message: 'not used' }))
  }
  use(id: number): Promise<Result<void, AnimalInteractionFailure>> {
    this.used.push(id)
    const target = this.find(id)
    if (this.ignoreClicks || target === undefined) return Promise.resolve(ok(undefined))
    if (this.held === 'shears' && target.species === 'sheep') {
      this.animals = this.animals.map((a) => (a.id === id ? { ...a, sheared: true } : a))
      this.give(`${target.colour ?? 'white'}_wool`, 2)
    }
    if (this.held === 'bucket' && (target.species === 'cow' || target.species === 'mooshroom')) {
      this.give('bucket', -1)
      this.give('milk_bucket', 1)
    }
    return Promise.resolve(ok(undefined))
  }

  give(name: string, by: number): void {
    const stacks = [...(this.inventory.value?.stacks ?? [])]
    const index = stacks.findIndex((stack) => stack.name === name)
    if (index >= 0) {
      const count = (stacks[index]?.count ?? 0) + by
      if (count > 0) stacks[index] = { name, count }
      else stacks.splice(index, 1)
    } else if (by > 0) stacks.push({ name, count: by })
    if (this.inventory.value !== undefined)
      this.inventory.value = { ...this.inventory.value, stacks }
  }
}

async function setup(items: Record<string, number>, animals: AnimalInfo[]) {
  const world = new World(items)
  world.animals = animals
  const clock = new FakeClock()
  const scheduler = new AutoScheduler(clock)
  const navigator: Navigator = new InstantNavigator()
  const farms = new FarmRegistry(clock)
  await farms.attach(new InMemoryStateStore())
  const { guard } = penGateSetup()
  const picked: string[] = []
  const drops = {
    collect: () => {
      picked.push('swept')
      return Promise.resolve()
    },
  }
  const shear = new ShearSheepSkill({
    animals: world,
    interaction: world,
    navigator,
    inventory: world.inventory,
    drops,
    farms,
    scheduler,
    gates: guard,
  })
  const milk = new MilkCowsSkill({
    animals: world,
    interaction: world,
    navigator,
    inventory: world.inventory,
    farms,
    scheduler,
    gates: guard,
  })
  return { world, shear, milk, farms, picked }
}

const shearAll = {
  farm: undefined,
  area: undefined,
  count: undefined,
  maxDistance: 24,
  colour: undefined,
}
const milkOne = { farm: undefined, area: undefined, count: 1, maxDistance: 24 }

describe('productSkip', () => {
  it('leaves babies, named, tamed, saddled, and ridden animals alone, and sheared sheep', () => {
    expect(productSkip(animal(1, 'sheep'))).toBeUndefined()
    expect(productSkip(animal(1, 'sheep', { baby: true }))).toBe('baby')
    expect(productSkip(animal(1, 'sheep', { named: true }))).toBe('named')
    expect(productSkip(animal(1, 'cow', { owned: true }))).toBe('tamed')
    expect(productSkip(animal(1, 'cow', { saddled: true }))).toBe('saddled')
    expect(productSkip(animal(1, 'cow', { ridden: true }))).toBe('ridden')
    expect(productSkip(animal(1, 'sheep', { sheared: true }))).toBe('sheared')
    expect(productSkip(animal(1, 'mooshroom'))).toBeUndefined()
  })
})

describe('ShearSheepSkill', () => {
  it('shears every adult sheep in reach, counts the wool by colour, and leaves them alive', async () => {
    const { world, shear, picked } = await setup({ shears: 1 }, [
      animal(1, 'sheep', { colour: 'white' }),
      animal(2, 'sheep', { colour: 'black' }),
      animal(3, 'cow'),
    ])
    const { context, progress } = skillContext()

    const result = await shear.run(shearAll, context)

    expect(result).toEqual({
      ok: true,
      value: { sheared: 2, wool: { white_wool: 2, black_wool: 2 }, skipped: {} },
    })
    expect(world.used).toEqual([1, 2])
    expect(world.animals).toHaveLength(3)
    expect(picked).toEqual(['swept'])
    expect(progress).toContain('Sheared 2 sheep')
  })

  it('skips sheared, baby, named, and tamed sheep and says why', async () => {
    const { shear } = await setup({ shears: 1 }, [
      animal(1, 'sheep', { sheared: true }),
      animal(2, 'sheep', { baby: true }),
      animal(3, 'sheep', { named: true }),
      animal(4, 'sheep', { owned: true }),
      animal(5, 'sheep'),
    ])
    const { context } = skillContext()

    const result = await shear.run(shearAll, context)

    expect(result).toMatchObject({
      ok: true,
      value: { sheared: 1, skipped: { sheared: 1, baby: 1, named: 1, tamed: 1 } },
    })
  })

  it('stops at count, and takes only the colour asked for', async () => {
    const { world, shear } = await setup({ shears: 1 }, [
      animal(1, 'sheep', { colour: 'white' }),
      animal(2, 'sheep', { colour: 'pink' }),
      animal(3, 'sheep', { colour: 'pink' }),
    ])
    const { context } = skillContext()

    const result = await shear.run({ ...shearAll, colour: 'pink', count: 1 }, context)

    expect(result).toMatchObject({ ok: true, value: { sheared: 1, skipped: { colour: 1 } } })
    expect(world.used).toEqual([2])
  })

  it('fails without shears, without sheep, and for an unknown farm', async () => {
    const { context } = skillContext()
    const bare = await setup({}, [animal(1, 'sheep')])
    expect(await bare.shear.run(shearAll, context)).toMatchObject({
      ok: false,
      error: { reason: 'no_shears' },
    })
    const empty = await setup({ shears: 1 }, [animal(1, 'cow')])
    expect(await empty.shear.run(shearAll, context)).toMatchObject({
      ok: false,
      error: { reason: 'no_sheep' },
    })
    expect(await empty.shear.run({ ...shearAll, farm: 'nope' }, context)).toMatchObject({
      ok: false,
      error: { reason: 'unknown_farm' },
    })
  })

  it('counts a sheep as not shorn when the click had no effect', async () => {
    const { world, shear } = await setup({ shears: 1 }, [animal(1, 'sheep')])
    world.ignoreClicks = true
    const { context } = skillContext()

    const result = await shear.run(shearAll, context)

    expect(result).toMatchObject({ ok: true, value: { sheared: 0, skipped: { no_effect: 1 } } })
  })

  it('works only the sheep inside a pen area', async () => {
    const { world, shear } = await setup({ shears: 1 }, [
      animal(1, 'sheep', { position: { x: 2, y: 64, z: 2 } }),
      animal(2, 'sheep', { position: { x: 30, y: 64, z: 2 } }),
    ])
    const { context } = skillContext()

    const result = await shear.run(
      { ...shearAll, area: { from: { x: 0, y: 64, z: 0 }, to: { x: 5, y: 64, z: 5 } } },
      context,
    )

    expect(result).toMatchObject({ ok: true, value: { sheared: 1 } })
    expect(world.used).toEqual([1])
  })

  it('stops when cancelled', async () => {
    const { shear } = await setup({ shears: 1 }, [animal(1, 'sheep')])
    const { context, controller } = skillContext()
    controller.abort()

    expect(await shear.run(shearAll, context)).toMatchObject({
      ok: false,
      error: { reason: 'aborted' },
    })
  })
})

describe('a registered pen', () => {
  const PEN = { from: { x: 0, y: 64, z: 0 }, to: { x: 5, y: 64, z: 5 } }

  it("shears and milks by the pen's label, and leaves out what stands outside it", async () => {
    const inside = { position: { x: 2, y: 64, z: 2 } }
    const { shear, milk, farms, world } = await setup({ shears: 1, bucket: 1 }, [
      animal(1, 'sheep', inside),
      animal(2, 'cow', inside),
      animal(3, 'sheep', { position: { x: 40, y: 64, z: 2 } }),
    ])
    farms.register({ kind: 'pen', species: 'sheep', bounds: PEN, label: 'pen' })
    const { context } = skillContext()

    const sheared = await shear.run({ ...shearAll, farm: 'pen' }, context)
    const milked = await milk.run({ ...milkOne, farm: 'pen' }, context)

    expect(sheared).toMatchObject({ ok: true, value: { sheared: 1 } })
    expect(milked).toMatchObject({ ok: true, value: { buckets: 1 } })
    expect(world.used).toEqual([1, 2])
  })
})

describe('MilkCowsSkill', () => {
  it('fills a bucket for each cow, one cow once, and a mooshroom counts', async () => {
    const { world, milk } = await setup({ bucket: 3 }, [
      animal(1, 'cow'),
      animal(2, 'mooshroom'),
      animal(3, 'sheep'),
    ])
    const { context } = skillContext()

    const result = await milk.run({ ...milkOne, count: 5 }, context)

    expect(result).toEqual({
      ok: true,
      value: { buckets: 2, requested: 5, cows: 2, skipped: {} },
    })
    expect(world.used).toEqual([1, 2])
    expect(world.inventory.value?.stacks.find((s) => s.name === 'milk_bucket')?.count).toBe(2)
  })

  it('stops when the buckets run out', async () => {
    const { milk } = await setup({ bucket: 1 }, [animal(1, 'cow'), animal(2, 'cow')])
    const { context } = skillContext()

    const result = await milk.run({ ...milkOne, count: 2 }, context)

    expect(result).toMatchObject({ ok: true, value: { buckets: 1, requested: 2 } })
  })

  it('skips calves, named, and tamed cows', async () => {
    const { milk } = await setup({ bucket: 4 }, [
      animal(1, 'cow', { baby: true }),
      animal(2, 'cow', { named: true }),
      animal(3, 'cow', { owned: true }),
      animal(4, 'cow'),
    ])
    const { context } = skillContext()

    const result = await milk.run({ ...milkOne, count: 4 }, context)

    expect(result).toMatchObject({
      ok: true,
      value: { buckets: 1, skipped: { baby: 1, named: 1, tamed: 1 } },
    })
  })

  it('fails without a bucket, without cows, and for an unknown farm', async () => {
    const { context } = skillContext()
    const bare = await setup({}, [animal(1, 'cow')])
    expect(await bare.milk.run(milkOne, context)).toMatchObject({
      ok: false,
      error: { reason: 'no_bucket' },
    })
    const none = await setup({ bucket: 1 }, [animal(1, 'sheep')])
    expect(await none.milk.run(milkOne, context)).toMatchObject({
      ok: false,
      error: { reason: 'no_cows' },
    })
    expect(await none.milk.run({ ...milkOne, farm: 'nope' }, context)).toMatchObject({
      ok: false,
      error: { reason: 'unknown_farm' },
    })
  })

  it('counts nothing when the milk does not arrive', async () => {
    const { world, milk } = await setup({ bucket: 1 }, [animal(1, 'cow')])
    world.ignoreClicks = true
    const { context } = skillContext()

    const result = await milk.run(milkOne, context)

    expect(result).toMatchObject({ ok: true, value: { buckets: 0, skipped: { no_effect: 1 } } })
  })

  it('stops when cancelled', async () => {
    const { milk } = await setup({ bucket: 1 }, [animal(1, 'cow')])
    const { context, controller } = skillContext()
    controller.abort()

    expect(await milk.run(milkOne, context)).toMatchObject({
      ok: false,
      error: { reason: 'aborted' },
    })
  })
})
