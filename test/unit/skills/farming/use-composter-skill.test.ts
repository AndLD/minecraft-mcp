import { describe, expect, it } from '@jest/globals'
import type { BlockUser } from '../../../../src/core/block-user.port.js'
import type { ComposterAccess } from '../../../../src/core/composter.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { err, ok, type Result } from '../../../../src/core/result.js'
import { compostChance, isScrap } from '../../../../src/skills/farming/compostables.js'
import { UseComposterSkill } from '../../../../src/skills/farming/use-composter-skill.js'
import { Bag } from '../../../fakes/bag-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeBlockScanner } from '../../../fakes/fake-ports.js'
import {
  AutoScheduler,
  FakeAreaGuard,
  InstantNavigator,
  skillContext,
} from '../../../fakes/gathering-fakes.js'

const AT = { x: 4, y: 64, z: 0 }

/** A composter that takes an item per click, going up a level for each one the `lucky` rule lets through. */
class Composter implements ComposterAccess, BlockUser {
  level = 0
  isComposter = true
  readonly clicks: (string | undefined)[] = []
  /** Which clicks raise the level (by index); every one by default. */
  lucky: (n: number) => boolean = () => true
  /** Ticks the level 7 stays before it turns ready: the number of reads. */
  readyAfterReads = 0
  private reads = 0
  private n = 0

  /** What emptying it does: by default the bone meal is in the bag at once (picked up). */
  onEmpty: () => void = () => {
    this.bag.give('bone_meal', 1)
  }

  constructor(private readonly bag: Bag) {}

  levelAt(): number | undefined {
    if (!this.isComposter) return undefined
    if (this.level === 7) {
      this.reads += 1
      if (this.reads > this.readyAfterReads) this.level = 8
    }
    return this.level
  }

  use(_position: Position, item: string | undefined): Promise<Result<void>> {
    this.clicks.push(item)
    if (item === undefined) {
      if (this.level === 8) {
        this.level = 0
        this.onEmpty()
      }
      return Promise.resolve(ok(undefined))
    }
    if (this.bag.count(item) === 0) return Promise.resolve(err('no item'))
    if (this.level < 7) {
      this.bag.give(item, -1)
      if (this.lucky(this.n)) this.level += 1
      this.n += 1
    }
    return Promise.resolve(ok(undefined))
  }
}

function setup(items: Record<string, number>) {
  const bag = new Bag(items)
  const composter = new Composter(bag)
  const scanner = new FakeBlockScanner()
  scanner.blocks = [{ name: 'composter', position: AT, distance: 4 }]
  const guard = new FakeAreaGuard()
  const navigator = new InstantNavigator()
  const clock = new FakeClock()
  /** Bone meal that popped out but can only be picked up from the `giveAt`th look on. */
  const collects = { count: 0, giveAt: 1, pending: 0 }
  const skill = new UseComposterSkill({
    blocks: scanner,
    composters: composter,
    user: composter,
    navigator,
    inventory: bag,
    drops: {
      collect: () => {
        collects.count += 1
        if (collects.count >= collects.giveAt && collects.pending > 0) {
          bag.give('bone_meal', collects.pending)
          collects.pending = 0
        }
        return Promise.resolve()
      },
    },
    guard,
    scheduler: new AutoScheduler(clock),
  })
  return { bag, composter, scanner, guard, skill, navigator, collects }
}

const all = { at: undefined, items: undefined, collect: true }

describe('UseComposterSkill', () => {
  it('composts the scraps it carries until the composter is ready, and takes the bone meal', async () => {
    const { skill, bag, composter } = setup({ wheat_seeds: 10, oak_sapling: 3, bread: 2 })
    const { context } = skillContext()

    const result = await skill.run(all, context)

    // Seven items raise it to 7 (and it turns ready); the bread is food and stays.
    expect(result).toEqual({
      ok: true,
      value: {
        composted: [
          { name: 'oak_sapling', count: 3 },
          { name: 'wheat_seeds', count: 4 },
        ],
        boneMeal: 1,
        level: 0,
        composter: AT,
      },
    })
    expect(bag.count('bread')).toBe(2)
    expect(composter.clicks.at(-1)).toBeUndefined()
  })

  it('counts items that do not raise the level, and keeps going', async () => {
    const { skill, composter } = setup({ wheat_seeds: 30 })
    composter.lucky = (n) => n % 3 === 2
    const { context } = skillContext()

    const result = await skill.run(all, context)

    expect(result).toMatchObject({
      ok: true,
      value: { composted: [{ name: 'wheat_seeds', count: 21 }], boneMeal: 1 },
    })
  })

  it('waits for a full composter to turn ready', async () => {
    const { skill, composter } = setup({ wheat_seeds: 10 })
    composter.readyAfterReads = 3
    const { context } = skillContext()

    const result = await skill.run(all, context)

    expect(result).toMatchObject({ ok: true, value: { boneMeal: 1, level: 0 } })
  })

  it('looks for the bone meal again when it cannot be picked up at once', async () => {
    const { skill, composter, collects } = setup({ wheat_seeds: 10 })
    composter.onEmpty = () => {
      collects.pending += 1
    }
    collects.giveAt = 3
    const { context } = skillContext()

    const result = await skill.run(all, context)

    expect(result).toMatchObject({ ok: true, value: { boneMeal: 1 } })
    expect(collects.count).toBe(3)
  })

  it('leaves the bone meal in when collect is false', async () => {
    const { skill } = setup({ wheat_seeds: 10 })
    const { context } = skillContext()

    const result = await skill.run({ ...all, collect: false }, context)

    expect(result).toMatchObject({ ok: true, value: { boneMeal: 0, level: 8 } })
  })

  it('empties a composter that is already ready, with nothing to put in', async () => {
    const { skill, composter } = setup({})
    composter.level = 8
    const { context } = skillContext()

    const result = await skill.run(all, context)

    expect(result).toMatchObject({ ok: true, value: { composted: [], boneMeal: 1 } })
  })

  it('composts named items, even food, and refuses what is not compostable', async () => {
    const { skill, bag } = setup({ wheat: 9, cobblestone: 4 })
    const { context } = skillContext()

    const named = await skill.run({ ...all, items: ['wheat'] }, context)
    expect(named).toMatchObject({ ok: true, value: { composted: [{ name: 'wheat', count: 7 }] } })
    expect(bag.count('wheat')).toBe(2)

    const bad = await skill.run({ ...all, items: ['cobblestone'] }, context)
    expect(bad).toMatchObject({ ok: false, error: { reason: 'not_compostable' } })
  })

  it('says when there is nothing to compost', async () => {
    const { skill } = setup({ bread: 2, iron_pickaxe: 1 })
    const { context } = skillContext()

    expect(await skill.run(all, context)).toMatchObject({
      ok: false,
      error: { reason: 'nothing_to_compost' },
    })
  })

  it('fails without a composter, on another block, and in a protected area', async () => {
    const { skill, scanner, composter, guard } = setup({ wheat_seeds: 3 })
    const { context } = skillContext()
    composter.isComposter = false
    expect(await skill.run({ ...all, at: AT }, context)).toMatchObject({
      ok: false,
      error: { reason: 'no_composter' },
    })
    composter.isComposter = true
    scanner.blocks = []
    expect(await skill.run(all, context)).toMatchObject({
      ok: false,
      error: { reason: 'no_composter' },
    })
    guard.protect('build', () => true)
    expect(await skill.run({ ...all, at: AT }, context)).toMatchObject({
      ok: false,
      error: { reason: 'protected_area' },
    })
  })

  it('stops when cancelled', async () => {
    const { skill } = setup({ wheat_seeds: 3 })
    const { context, controller } = skillContext()
    controller.abort()

    expect(await skill.run(all, context)).toMatchObject({ ok: false, error: { reason: 'aborted' } })
  })
})

describe('compostables', () => {
  it('knows the chances, and leaves food and tools out of the scraps', () => {
    expect(compostChance('wheat_seeds')).toBe(30)
    expect(compostChance('oak_leaves')).toBe(30)
    expect(compostChance('oak_sapling')).toBe(30)
    expect(compostChance('bread')).toBe(85)
    expect(compostChance('cake')).toBe(100)
    expect(compostChance('cobblestone')).toBeUndefined()
    expect(['wheat_seeds', 'oak_leaves', 'oak_sapling', 'kelp', 'short_grass'].every(isScrap)).toBe(
      true,
    )
    expect(['bread', 'wheat', 'iron_pickaxe', 'carrot'].some(isScrap)).toBe(false)
  })
})
