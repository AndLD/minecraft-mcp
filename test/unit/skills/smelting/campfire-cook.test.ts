import { describe, expect, it } from '@jest/globals'
import { PlacementSpotFinder } from '../../../../src/skills/crafting/placement-spot.js'
import { Workstations } from '../../../../src/skills/crafting/workstations.js'
import { CampfireCookSkill } from '../../../../src/skills/smelting/campfire-cook-skill.js'
import { SmeltItemsSkill } from '../../../../src/skills/smelting/smelt-items-skill.js'
import { SMELTING_TABLE } from '../../../../src/skills/smelting/smelting-table.js'
import { SmeltJobs } from '../../../../src/state/smelt-jobs.js'
import { FakeCampfire } from '../../../fakes/campfire-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import {
  FakeBlockScanner,
  FakeInventory,
  FakeVitals,
  buildVitals,
} from '../../../fakes/fake-ports.js'
import {
  AutoScheduler,
  FakeAreaGuard,
  FakeFurnaceAccess,
  FakePlacer,
  InstantNavigator,
  skillContext,
} from '../../../fakes/gathering-fakes.js'
import { ok } from '../../../../src/core/result.js'

const FIRE = { x: 3, y: 64, z: 0 }

function setup(
  items: Record<string, number>,
  options: { blocks?: string[]; standing?: { x: number; y: number; z: number } } = {},
) {
  const clock = new FakeClock()
  const scanner = new FakeBlockScanner()
  scanner.blocks = (options.blocks ?? ['campfire']).map((name) => ({
    name,
    position: name === 'campfire' || name === 'soul_campfire' ? FIRE : { x: 0, y: 64, z: 3 },
    distance: 3,
  }))
  const inventory = new FakeInventory()
  inventory.value = {
    stacks: Object.entries(items).map(([name, count]) => ({ name, count })),
    emptySlots: 30,
    heldItem: undefined,
  }
  const vitals = new FakeVitals()
  vitals.vitals = buildVitals({ position: options.standing ?? { x: 0.5, y: 64, z: 0.5 } })
  const navigator = new InstantNavigator()
  const campfire = new FakeCampfire(clock, inventory, SMELTING_TABLE)
  const guard = new FakeAreaGuard()
  const workstations = new Workstations({
    blocks: scanner,
    navigator,
    placer: new FakePlacer(),
    inventory,
    vitals,
    spots: new PlacementSpotFinder(scanner),
  })
  const cook = new CampfireCookSkill({
    fires: campfire.access,
    workstations,
    navigator,
    inventory,
    drops: campfire.drops,
    guard,
    vitals,
    scheduler: new AutoScheduler(clock),
    clock,
  })
  const furnaces = new FakeFurnaceAccess()
  const skill = new SmeltItemsSkill({
    inventory,
    furnaces,
    workstations,
    crafter: {
      run: () =>
        Promise.resolve(ok({ item: 'furnace', produced: 1, steps: [], placedTable: false })),
    },
    clock,
    scheduler: new AutoScheduler(clock),
    navigator,
    jobs: new SmeltJobs(),
    vitals,
    campfire: cook,
  })
  /** A furnace finishes the moment it is looked at. */
  furnaces.session.onLook = () => {
    const session = furnaces.session
    if (session.input === undefined) return
    const made = SMELTING_TABLE[session.input.name] ?? 'unknown'
    session.output = { name: made, count: (session.output?.count ?? 0) + session.input.count }
    session.input = undefined
  }
  return { clock, scanner, inventory, campfire, cook, skill, guard, navigator, furnaces }
}

const count = (inventory: FakeInventory, name: string): number =>
  inventory.value?.stacks.find((stack) => stack.name === name)?.count ?? 0

describe('CampfireCookSkill', () => {
  it('puts four on at a time, waits, picks up what pops out, and goes on', async () => {
    const { cook, campfire, inventory, clock } = setup({ beef: 6 })
    const { context } = skillContext()
    const started = clock.now()

    const result = await cook.cook(
      { item: 'beef', produced: 'cooked_beef', count: undefined },
      context,
    )

    expect(result).toEqual({ ok: true, value: { cooked: 6, fire: FIRE } })
    expect(campfire.puts).toHaveLength(6)
    expect(count(inventory, 'cooked_beef')).toBe(6)
    expect(count(inventory, 'beef')).toBe(0)
    // Two rounds of 30 seconds.
    expect(clock.now() - started).toBeGreaterThanOrEqual(60_000)
  })

  it('walks to the fire first, and never stays on top of it', async () => {
    const { cook, navigator } = setup({ chicken: 1 }, { standing: { x: 3.5, y: 64, z: 0.5 } })
    const { context } = skillContext()

    await cook.cook({ item: 'chicken', produced: 'cooked_chicken', count: 1 }, context)

    expect(navigator.trips[0]).toEqual({ target: FIRE, within: 2.5 })
    expect(navigator.trips[1]?.target).toEqual({ x: 5, y: 64, z: 0 })
  })

  it('fails when there is no campfire', async () => {
    const { cook } = setup({ beef: 1 }, { blocks: [] })
    const { context } = skillContext()

    const result = await cook.cook({ item: 'beef', produced: 'cooked_beef', count: 1 }, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_campfire' } })
  })

  it('does not use a campfire in a protected area', async () => {
    const { cook, guard, campfire } = setup({ beef: 1 })
    guard.protect('camp', () => true)
    const { context } = skillContext()

    const result = await cook.cook({ item: 'beef', produced: 'cooked_beef', count: 1 }, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'protected_area' } })
    expect(campfire.puts).toEqual([])
  })

  it('says when the fire is out, and when the block is gone', async () => {
    const { cook, campfire } = setup({ beef: 1 })
    const { context } = skillContext()
    campfire.state = 'out'
    expect(
      await cook.cook({ item: 'beef', produced: 'cooked_beef', count: 1 }, context),
    ).toMatchObject({
      ok: false,
      error: { reason: 'campfire_out' },
    })
    campfire.state = 'none'
    expect(
      await cook.cook({ item: 'beef', produced: 'cooked_beef', count: 1 }, context),
    ).toMatchObject({
      ok: false,
      error: { reason: 'no_campfire' },
    })
  })

  it('fails with missing_items when the bot does not carry enough', async () => {
    const { cook } = setup({ beef: 2 })
    const { context } = skillContext()

    const result = await cook.cook({ item: 'beef', produced: 'cooked_beef', count: 5 }, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'missing_items' } })
  })

  it('gives up when the campfire keeps refusing food', async () => {
    const { cook, campfire } = setup({ beef: 2 })
    campfire.refuseWith = 'The campfire did not take the item.'
    const { context } = skillContext()

    const result = await cook.cook({ item: 'beef', produced: 'cooked_beef', count: 2 }, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'campfire_full' } })
  })

  it('waits for a slot when the campfire is full of food that is still cooking', async () => {
    const { cook, campfire, inventory } = setup({ beef: 5 })
    const { context } = skillContext()

    const result = await cook.cook({ item: 'beef', produced: 'cooked_beef', count: 5 }, context)

    expect(result.ok).toBe(true)
    expect(campfire.puts).toHaveLength(5)
    expect(count(inventory, 'cooked_beef')).toBe(5)
  })

  it('reports what is still on the fire when it is cancelled', async () => {
    const { cook, campfire } = setup({ beef: 4 })
    const { context, controller } = skillContext()
    campfire.onPut = () => {
      controller.abort()
    }

    const result = await cook.cook({ item: 'beef', produced: 'cooked_beef', count: 4 }, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    if (!result.ok) expect(result.error.message).toContain('still on the fire will pop out')
  })
})

describe('SmeltItemsSkill with a campfire', () => {
  it('cooks small batches of food on a campfire even when the bag has fuel', async () => {
    const { skill, campfire, inventory, furnaces } = setup({ chicken: 4, coal: 3 })
    const { context } = skillContext()

    const result = await skill.run({ item: 'chicken', count: undefined, fuel: undefined }, context)

    expect(result).toMatchObject({
      ok: true,
      value: {
        station: 'campfire',
        smelted: 4,
        produced: 'cooked_chicken',
        pending: 0,
        fuelUsed: [],
      },
    })
    expect(campfire.puts).toHaveLength(4)
    expect(count(inventory, 'cooked_chicken')).toBe(4)
    expect(furnaces.opened).toEqual([])
  })

  it('cooks without any fuel', async () => {
    const { skill } = setup({ beef: 12 })
    const { context } = skillContext()

    const result = await skill.run({ item: 'beef', count: undefined, fuel: undefined }, context)

    expect(result).toMatchObject({ ok: true, value: { station: 'campfire', smelted: 12 } })
  })

  it('uses a furnace for a big batch when the bag has fuel', async () => {
    const { skill, campfire } = setup({ beef: 20, coal: 5 }, { blocks: ['campfire', 'furnace'] })
    const { context } = skillContext()

    const result = await skill.run({ item: 'beef', count: undefined, fuel: undefined }, context)

    expect(campfire.puts).toEqual([])
    expect(result.ok ? result.value.station : 'failed').not.toBe('campfire')
  })

  it('prefers a smoker that stands nearby', async () => {
    const { skill, campfire } = setup({ beef: 2, coal: 1 }, { blocks: ['campfire', 'smoker'] })
    const { context } = skillContext()

    const result = await skill.run({ item: 'beef', count: undefined, fuel: undefined }, context)

    expect(campfire.puts).toEqual([])
    expect(result.ok ? result.value.station : 'failed').toBe('smoker')
  })

  it('does not cook ores or kelp on a campfire by itself', async () => {
    const { skill, campfire } = setup({ kelp: 2, coal: 1 }, { blocks: ['campfire', 'furnace'] })
    const { context } = skillContext()

    const result = await skill.run({ item: 'kelp', count: undefined, fuel: undefined }, context)

    expect(campfire.puts).toEqual([])
    expect(result.ok ? result.value.station : 'failed').toBe('furnace')
  })

  it('cooks on a soul campfire too', async () => {
    const { skill } = setup({ cod: 2 }, { blocks: ['soul_campfire'] })
    const { context } = skillContext()

    const result = await skill.run({ item: 'cod', count: undefined, fuel: undefined }, context)

    expect(result).toMatchObject({ ok: true, value: { station: 'campfire', smelted: 2 } })
  })

  it('names the campfire: wrong_station for ores, no_campfire when there is none', async () => {
    const { skill } = setup({ raw_iron: 2 })
    const { context } = skillContext()
    const named = { count: undefined, fuel: undefined, station: 'campfire' } as const

    expect(await skill.run({ item: 'raw_iron', ...named }, context)).toMatchObject({
      ok: false,
      error: { reason: 'wrong_station' },
    })
    const bare = setup({ beef: 2 }, { blocks: [] })
    expect(await bare.skill.run({ item: 'beef', ...named }, context)).toMatchObject({
      ok: false,
      error: { reason: 'no_campfire' },
    })
  })
})
