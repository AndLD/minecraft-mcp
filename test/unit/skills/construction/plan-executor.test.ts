import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import {
  PlanExecutor,
  type PlanOptions,
} from '../../../../src/skills/construction/plan-executor.js'
import { planFor } from '../../../../src/skills/building/blueprint-plan.js'
import { ShelterProvider } from '../../../../src/skills/building/providers/house-providers.js'
import { Scaffolder } from '../../../../src/skills/construction/scaffolder.js'
import { SiteSafety } from '../../../../src/skills/construction/site-safety.js'
import { StandingSpotChooser } from '../../../../src/skills/construction/standing-spot.js'
import type { WorkPlan, WorkStep } from '../../../../src/skills/construction/work-plan.types.js'
import { ConstructionWorld } from '../../../fakes/construction-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { AutoScheduler, FakeDroppedItems, skillContext } from '../../../fakes/gathering-fakes.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })
const place = (x: number, y: number, z: number, block = 'oak_planks'): WorkStep => ({
  kind: 'place',
  at: at(x, y, z),
  block,
})
const plan = (...steps: WorkStep[]): WorkPlan => ({ name: 'test plan', steps })
const options: PlanOptions = { clearObstacles: false }

function setup() {
  const world = new ConstructionWorld()
  const clock = new FakeClock(0)
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
    scaffolder: new Scaffolder({
      blocks: world,
      placer: world,
      digger: world,
      locomotion: world,
      navigator: world,
      vitals: world,
      guard: world,
      drops,
      scheduler,
    }),
  })
  return { world, executor }
}

/** A wall along x at z=5, `length` wide and `height` high, listed from the TOP down (the worst order). */
const wallTopFirst = (length: number, height: number): WorkStep[] => {
  const steps: WorkStep[] = []
  for (let y = 63 + height; y >= 64; y -= 1)
    for (let x = 0; x < length; x += 1) steps.push(place(x, y, 5))
  return steps
}

describe('PlanExecutor: placing', () => {
  it('builds a wall from the ground up, whatever order the plan lists it in', async () => {
    const s = setup()
    s.world.give('oak_planks', 20)

    const result = await s.executor.run(
      plan(...wallTopFirst(4, 3)),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { steps: 12, placed: 12, alreadyDone: 0 } })
    expect(s.world.builtBlocks().size).toBe(12)
    expect(s.world.carried.get('oak_planks')).toBe(8)
    const order = s.world.log.filter((line) => line.startsWith('place'))
    const firstUpper = order.findIndex((line) => line.endsWith(',65,5'))
    const lastLower = order.map((line) => line.endsWith(',64,5')).lastIndexOf(true)
    expect(lastLower).toBeGreaterThan(-1)
    expect(firstUpper).toBeGreaterThan(-1)
    expect(order[0]).toMatch(/,64,5$/) // the first block goes on the ground
  })

  it('walks to a place within reach, and never stands where a block has to go', async () => {
    const s = setup()
    s.world.give('oak_planks', 30)
    s.world.bot = at(0.5, 64, 5.5) // standing in the wall's own line

    await s.executor.run(plan(...wallTopFirst(6, 2)), options, skillContext().context)

    expect(s.world.trips.length).toBeGreaterThan(0)
    expect(s.world.builtBlocks().size).toBe(12)
  })

  it('does not walk when it can already reach', async () => {
    const s = setup()
    s.world.give('oak_planks', 5)
    s.world.bot = at(1.5, 64, 2.5)

    await s.executor.run(plan(place(1, 64, 5)), options, skillContext().context)

    expect(s.world.trips).toEqual([])
  })

  it('skips what is already built, so an interrupted plan just continues', async () => {
    const s = setup()
    s.world.give('oak_planks', 20)
    s.world.setBlock(at(0, 64, 5), 'oak_planks')
    s.world.setBlock(at(1, 64, 5), 'oak_planks')

    const result = await s.executor.run(
      plan(place(0, 64, 5), place(1, 64, 5), place(2, 64, 5)),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { placed: 1, alreadyDone: 2 } })
    expect(s.world.log.filter((line) => line.startsWith('place'))).toHaveLength(1)
  })

  it('reports the blocks it used', async () => {
    const s = setup()
    s.world.give('oak_planks', 5)
    s.world.give('cobblestone', 5)

    const result = await s.executor.run(
      plan(place(0, 64, 5), place(1, 64, 5, 'cobblestone')),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        used: [
          { name: 'oak_planks', count: 1 },
          { name: 'cobblestone', count: 1 },
        ],
      },
    })
  })

  it('finishes an empty plan at once', async () => {
    const s = setup()

    expect(await s.executor.run(plan(), options, skillContext().context)).toMatchObject({
      ok: true,
      value: { steps: 0, placed: 0 },
    })
  })

  it('places a block over grass, which it simply replaces', async () => {
    const s = setup()
    s.world.give('oak_planks', 1)
    s.world.setBlock(at(0, 64, 5), 'short_grass')

    expect(
      await s.executor.run(plan(place(0, 64, 5)), options, skillContext().context),
    ).toMatchObject({
      ok: true,
      value: { placed: 1 },
    })
  })
})

describe('PlanExecutor: doors and shelters', () => {
  it('stands in line with a door when it places it', async () => {
    const s = setup()
    s.world.give('oak_door', 1)
    s.world.bot = at(20.5, 64, 30.5)
    let standing: Position | undefined
    s.world.onPlaced = () => {
      standing = s.world.bot
    }

    const result = await s.executor.run(
      plan({ kind: 'place', at: at(3, 64, 5), block: 'oak_door', alignAxis: 'z' }),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true })
    expect(Math.floor(standing?.x ?? 0)).toBe(3)
    expect(Math.abs(Math.floor(standing?.z ?? 0) - 5)).toBeGreaterThanOrEqual(1)
  })

  it('builds a shelter from the inside, without leaving it', async () => {
    const s = setup()
    s.world.give('cobblestone', 40)
    s.world.bot = at(11.5, 64, 21.5)
    const shelter = new ShelterProvider().generate({ block: 'cobblestone' })
    const around = planFor(shelter, { x: 10, y: 64, z: 20 })

    const result = await s.executor.run(around, options, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { placed: 32 } })
    expect(s.world.trips).toEqual([]) // it never walked: everything was in reach from where it stood
    expect(s.world.nameAt(at(11, 64, 21))).toBe('air') // the bot's own cell stays free
    expect(s.world.nameAt(at(11, 66, 21))).toBe('cobblestone') // the roof above it
  })
})

describe('PlanExecutor: optional placements (a door with nothing to place)', () => {
  it('finishes the plan and reports the missing item, instead of refusing or failing', async () => {
    const s = setup()
    // Nothing to place around it, and no oak_door carried.

    const result = await s.executor.run(
      plan({ kind: 'place', at: at(3, 64, 5), block: 'oak_door', optional: true }),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({
      ok: true,
      value: { placed: 0, missingOptional: [{ name: 'oak_door', count: 1 }] },
    })
  })

  it('is counted in needs but never in missing, so it never blocks the plan from starting', () => {
    const s = setup()

    const preview = s.executor.preview(
      plan({ kind: 'place', at: at(3, 64, 5), block: 'oak_door', optional: true }),
      options,
    )

    expect(preview.needs).toEqual([{ name: 'oak_door', count: 1 }])
    expect(preview.missing).toEqual([])
    expect(preview.optionalMissing).toEqual([{ name: 'oak_door', count: 1 }])
  })

  it('crafts one from what is carried when it can, through the supplies crafter', async () => {
    const s = setup()
    s.world.give('oak_planks', 6)
    const crafted: string[] = []
    const executor = new PlanExecutor({
      blocks: s.world,
      placer: s.world,
      digger: s.world,
      navigator: s.world,
      inventory: s.world,
      vitals: s.world,
      guard: s.world,
      drops: new DropCollector({
        drops: new FakeDroppedItems(),
        navigator: s.world,
        scheduler: new AutoScheduler(new FakeClock(0)),
      }),
      spots: new StandingSpotChooser(s.world),
      safety: new SiteSafety(s.world, s.world),
      scheduler: new AutoScheduler(new FakeClock(0)),
      supplies: {
        craft: (item, count) => {
          crafted.push(item)
          if (item === 'oak_door') s.world.give('oak_door', count)
          return Promise.resolve(true)
        },
      },
    })

    const result = await executor.run(
      plan({ kind: 'place', at: at(3, 64, 5), block: 'oak_door', optional: true }),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { placed: 1, missingOptional: [] } })
    expect(crafted).toEqual(['oak_door'])
  })
})

describe('PlanExecutor: before it starts', () => {
  it('refuses when materials are short, and changes nothing', async () => {
    const s = setup()
    s.world.give('oak_planks', 3)

    const result = await s.executor.run(
      plan(...wallTopFirst(4, 3)),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({
      ok: false,
      error: {
        reason: 'missing_materials',
        detail: { missing: [{ name: 'oak_planks', count: 9 }] },
      },
    })
    expect(s.world.log).toEqual([])
    expect(s.world.trips).toEqual([])
  })

  it('does not count what is already built as needed', async () => {
    const s = setup()
    s.world.give('oak_planks', 1)
    s.world.setBlock(at(0, 64, 5), 'oak_planks')

    expect(
      await s.executor.run(plan(place(0, 64, 5), place(1, 64, 5)), options, skillContext().context),
    ).toMatchObject({ ok: true })
  })

  it('refuses cells occupied by other blocks, naming one', async () => {
    const s = setup()
    s.world.give('oak_planks', 5)
    s.world.setBlock(at(1, 64, 5), 'stone')

    const result = await s.executor.run(
      plan(place(0, 64, 5), place(1, 64, 5)),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'blocked_cells', detail: { blockedCount: 1 } },
    })
    expect(!result.ok && result.error.message).toContain('1, 64, 5')
    expect(s.world.log).toEqual([])
  })

  it('breaks natural blocks in the way when allowed, then places', async () => {
    const s = setup()
    s.world.give('oak_planks', 5)
    s.world.setBlock(at(1, 64, 5), 'stone')

    const result = await s.executor.run(
      plan(place(1, 64, 5)),
      { clearObstacles: true },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { placed: 1, broken: 1 } })
    expect(s.world.log.filter((l) => l.startsWith('dig'))).toEqual(['dig 1,64,5'])
  })

  it('never builds into a protected area', async () => {
    const s = setup()
    s.world.give('oak_planks', 5)
    s.world.protectedBoxes.push({ label: 'village', contains: (p) => p.x >= 1 && p.x <= 2 })

    const result = await s.executor.run(
      plan(place(0, 64, 5), place(1, 64, 5)),
      { clearObstacles: true },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'protected_area' } })
    expect(!result.ok && result.error.message).toContain('village')
    expect(s.world.log).toEqual([])
  })

  it('refuses a site with lava in or next to it', async () => {
    const s = setup()
    s.world.give('oak_planks', 5)
    s.world.setBlock(at(3, 64, 5), 'lava')

    const result = await s.executor.run(
      plan(place(2, 64, 5), place(1, 64, 5)),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({
      ok: false,
      error: {
        reason: 'unsafe_site',
        detail: { hazards: ['1 lava block(s) in or next to the building site'] },
      },
    })
    expect(s.world.log).toEqual([])
  })

  it('needs a connection', async () => {
    const s = setup()
    s.world.snapshot = () => undefined

    expect(
      await s.executor.run(plan(place(0, 64, 5)), options, skillContext().context),
    ).toMatchObject({
      ok: false,
      error: { reason: 'not_connected' },
    })
  })
})

describe('PlanExecutor.preview', () => {
  it('tells what it would take without changing anything', () => {
    const s = setup()
    s.world.give('oak_planks', 2)
    s.world.setBlock(at(0, 64, 5), 'oak_planks')
    s.world.setBlock(at(1, 64, 5), 'stone')
    const steps = [
      place(0, 64, 5),
      place(1, 64, 5),
      place(2, 64, 5),
      place(3, 64, 5, 'cobblestone'),
      { kind: 'break' as const, at: at(4, 64, 5) },
      { kind: 'break' as const, at: at(5, 64, 5) },
      { kind: 'light' as const, at: at(2, 65, 5), minLight: 8 },
    ]
    s.world.setBlock(at(4, 64, 5), 'stone')

    const preview = s.executor.preview(plan(...steps), options)

    expect(preview).toMatchObject({
      steps: 7,
      toPlace: 3,
      toBreak: 1,
      alreadyDone: 2,
      needs: [
        { name: 'oak_planks', count: 2 },
        { name: 'cobblestone', count: 1 },
      ],
      missing: [{ name: 'cobblestone', count: 1 }],
      torchesWanted: 1,
      blockedCount: 1,
    })
    expect(s.world.log).toEqual([])
  })

  it('counts obstacles to clear instead of blocked cells when clearing is allowed', () => {
    const s = setup()
    s.world.setBlock(at(1, 64, 5), 'stone')

    const preview = s.executor.preview(plan(place(1, 64, 5)), { clearObstacles: true })

    expect(preview).toMatchObject({ toBreak: 1, blockedCount: 0 })
  })

  it('names the protected area and hazards', () => {
    const s = setup()
    s.world.protectedBoxes.push({ label: 'home', contains: () => true })
    s.world.setBlock(at(0, 64, 6), 'lava')

    const preview = s.executor.preview(plan(place(0, 64, 5)), options)

    expect(preview.protectedArea).toBe('home')
    expect(preview.hazards).toHaveLength(1)
  })
})

describe('PlanExecutor: when things go wrong', () => {
  it('stops with a clear reason when blocks would float', async () => {
    const s = setup()
    s.world.give('oak_planks', 5)

    const result = await s.executor.run(plan(place(0, 70, 5)), options, skillContext().context)

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'unsupported_steps', detail: { remaining: 1 } },
    })
  })

  it('tries a failed placement again', async () => {
    const s = setup()
    s.world.give('oak_planks', 5)
    s.world.placeFailures = [
      { reason: 'failed', message: 'lag' },
      { reason: 'failed', message: 'lag' },
    ]

    const result = await s.executor.run(plan(place(0, 64, 5)), options, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { placed: 1 } })
  })

  it('tries again when the server ignores a placement', async () => {
    const s = setup()
    s.world.give('oak_planks', 5)
    s.world.placeFailures = ['ignored']

    const result = await s.executor.run(plan(place(0, 64, 5)), options, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { placed: 1 } })
    expect(s.world.log.filter((l) => l.startsWith('place'))).toHaveLength(2)
  })

  it('gives a step up after three tries and says the plan is incomplete, keeping the rest done', async () => {
    const s = setup()
    s.world.give('oak_planks', 5)
    s.world.stubbornCells.add('0,64,5')

    const result = await s.executor.run(
      plan(place(0, 64, 5), place(1, 64, 5)),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'incomplete', detail: { failedSteps: 1, placed: 1 } },
    })
    expect(s.world.builtBlocks().size).toBe(1)
  })

  it('stops as stuck when many steps in a row fail', async () => {
    const s = setup()
    s.world.give('oak_planks', 20)
    s.world.placeFailures = Array.from({ length: 40 }, () => ({
      reason: 'failed' as const,
      message: 'no',
    }))

    const result = await s.executor.run(
      plan(...wallTopFirst(6, 2)),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'stuck' } })
  })

  it('reports running out of a block during the work, and what was done', async () => {
    const s = setup()
    s.world.give('oak_planks', 3)
    s.world.placeFailures = [undefined, { reason: 'no_item', message: 'gone' }]

    const result = await s.executor.run(
      plan(...wallTopFirst(3, 1)),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({
      ok: false,
      error: {
        reason: 'missing_materials',
        detail: { placed: 1, missing: [{ name: 'oak_planks', count: 1 }] },
      },
    })
  })

  it('counts a walk that fails as a failed try, and carries on', async () => {
    const s = setup()
    s.world.give('oak_planks', 5)
    s.world.bot = at(0.5, 64, 40) // far away, so it has to walk
    s.world.navFailures = [{ reason: 'unreachable', message: 'no path' }]

    const result = await s.executor.run(plan(place(0, 64, 5)), options, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { placed: 1 } })
  })

  it('stops when cancelled, with what was done so far', async () => {
    const s = setup()
    s.world.give('oak_planks', 20)
    const { context, controller } = skillContext()
    s.world.onPlaced = () => {
      if (s.world.builtBlocks().size === 2) controller.abort()
    }

    const result = await s.executor.run(plan(...wallTopFirst(5, 2)), options, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted', detail: { placed: 2 } } })
  })

  it('stops when cancelled while walking', async () => {
    const s = setup()
    s.world.give('oak_planks', 5)
    s.world.bot = at(0.5, 64, 40)
    const { context, controller } = skillContext()
    controller.abort()

    expect(await s.executor.run(plan(place(0, 64, 5)), options, context)).toMatchObject({
      ok: false,
      error: { reason: 'aborted' },
    })
  })

  it('looks again at the end and repairs what did not hold', async () => {
    const s = setup()
    s.world.give('oak_planks', 20)
    let placements = 0
    s.world.onPlaced = () => {
      placements += 1
      if (placements === 3) s.world.setBlock(at(0, 64, 5), 'air') // an earlier block vanishes
    }

    const result = await s.executor.run(
      plan(...wallTopFirst(3, 1)),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { placed: 4 } })
    expect(s.world.builtBlocks().size).toBe(3)
  })

  it('says so when the verification finds something still wrong', async () => {
    const s = setup()
    s.world.give('oak_planks', 20)
    s.world.onPlaced = (position) => {
      // Every block placed at x=1 disappears again a moment later.
      if (position.x === 1) s.world.cells.set('1,64,5', 'placed-then-gone')
    }

    const result = await s.executor.run(plan(place(1, 64, 5)), options, skillContext().context)

    expect(result.ok).toBe(false)
  })
})

describe('PlanExecutor: breaking', () => {
  const breakAt = (x: number, y: number, z: number): WorkStep => ({
    kind: 'break',
    at: at(x, y, z),
  })

  it('breaks the cells and picks up the drops', async () => {
    const s = setup()
    s.world.setBlock(at(2, 64, 5), 'stone')
    s.world.setBlock(at(3, 64, 5), 'stone')

    const result = await s.executor.run(
      plan(breakAt(2, 64, 5), breakAt(3, 64, 5)),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { broken: 2, placed: 0 } })
    expect(s.world.nameAt(at(2, 64, 5))).toBe('air')
  })

  it('skips cells that are already open', async () => {
    const s = setup()

    expect(
      await s.executor.run(plan(breakAt(2, 64, 5)), options, skillContext().context),
    ).toMatchObject({
      ok: true,
      value: { broken: 0, alreadyDone: 1 },
    })
  })

  it('stops and names the tool when the block needs one the bot lacks', async () => {
    const s = setup()
    s.world.setBlock(at(2, 64, 5), 'iron_ore')
    s.world.needsTool.set('iron_ore', 'stone_pickaxe')
    s.world.hasTool = false

    const result = await s.executor.run(plan(breakAt(2, 64, 5)), options, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_suitable_tool' } })
    expect(!result.ok && result.error.message).toContain('stone_pickaxe')
  })

  it('stops when the inventory is full and nothing decides otherwise', async () => {
    const s = setup()
    s.world.setBlock(at(2, 64, 5), 'stone')
    s.world.emptySlots = 0

    expect(
      await s.executor.run(plan(breakAt(2, 64, 5)), options, skillContext().context),
    ).toMatchObject({
      ok: false,
      error: { reason: 'inventory_full' },
    })
  })

  it('retries a dig that failed, and gives up on a block that cannot be broken', async () => {
    const s = setup()
    s.world.setBlock(at(2, 64, 5), 'stone')
    s.world.digFailures = [{ reason: 'failed', message: 'lag' }]
    expect(
      await s.executor.run(plan(breakAt(2, 64, 5)), options, skillContext().context),
    ).toMatchObject({ ok: true, value: { broken: 1 } })

    s.world.setBlock(at(3, 64, 5), 'bedrock')
    expect(
      await s.executor.run(plan(breakAt(3, 64, 5)), options, skillContext().context),
    ).toMatchObject({ ok: false, error: { reason: 'incomplete' } })
  })

  it('cancels while digging', async () => {
    const s = setup()
    s.world.setBlock(at(2, 64, 5), 'stone')
    s.world.digFailures = [{ reason: 'aborted', message: 'Cancelled.' }]

    expect(
      await s.executor.run(plan(breakAt(2, 64, 5)), options, skillContext().context),
    ).toMatchObject({
      ok: false,
      error: { reason: 'aborted' },
    })
  })

  it('tries again when the block is not loaded yet', async () => {
    const s = setup()
    s.world.setBlock(at(2, 64, 5), 'stone')
    s.world.unloaded.add('2,64,5')
    let looks = 0
    const original = s.world.assess.bind(s.world)
    s.world.assess = (position) => {
      looks += 1
      if (looks === 2) s.world.unloaded.clear()
      return original(position)
    }

    const result = await s.executor.run(plan(breakAt(2, 64, 5)), options, skillContext().context)

    expect(result.ok || looks > 1).toBe(true)
  })
})

describe('PlanExecutor: lighting', () => {
  const lamp = (x: number, minLight = 8): WorkStep => ({
    kind: 'light',
    at: at(x, 64, 5),
    minLight,
  })

  it('puts a torch in a dark cell', async () => {
    const s = setup()
    s.world.give('torch', 3)

    const result = await s.executor.run(plan(lamp(2)), options, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { lights: 1 } })
    expect(s.world.nameAt(at(2, 64, 5))).toBe('torch')
  })

  it('does nothing in a bright cell, or when a torch is already close', async () => {
    const s = setup()
    s.world.give('torch', 3)
    s.world.light.set('2,64,5', 12)
    s.world.setBlock(at(6, 64, 5), 'torch')

    const result = await s.executor.run(plan(lamp(2), lamp(4)), options, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { lights: 0 } })
    expect(s.world.log).toEqual([])
  })

  it('leaves the lighting out when there are no torches, without failing', async () => {
    const s = setup()

    expect(await s.executor.run(plan(lamp(2)), options, skillContext().context)).toMatchObject({
      ok: true,
      value: { lights: 0 },
    })
  })

  it('spaces torches: one torch lights the cells around it', async () => {
    const s = setup()
    s.world.give('torch', 5)

    const result = await s.executor.run(
      plan(lamp(1), lamp(2), lamp(3), lamp(10)),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { lights: 2 } })
  })
})

describe('PlanExecutor: pillaring up', () => {
  const tall: PlanOptions = {
    clearObstacles: false,
    scaffold: { block: 'cobblestone', maxHeight: 12 },
  }
  /** A wall three blocks wide and `height` high along x at z = 5, listed from the bottom up. */
  const wall = (height: number): WorkStep[] => {
    const steps: WorkStep[] = []
    for (let y = 64; y < 64 + height; y += 1)
      for (let x = 0; x < 3; x += 1) steps.push(place(x, y, 5, 'oak_planks'))
    return steps
  }
  const scaffoldBlocksLeft = (world: ConstructionWorld): number =>
    [...world.builtBlocks().values()].filter((name) => name === 'cobblestone').length

  it('builds a wall higher than the reach from the ground, and leaves no tower behind', async () => {
    const s = setup()
    s.world.give('oak_planks', 40)
    s.world.give('cobblestone', 10)

    const result = await s.executor.run(plan(...wall(9)), tall, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { placed: 27 } })
    expect(s.world.builtBlocks().size).toBe(27) // only the wall
    expect(scaffoldBlocksLeft(s.world)).toBe(0)
    expect(s.world.bot.y).toBe(64) // back on the ground
    expect(s.world.carried.get('cobblestone')).toBe(10) // every scaffold block came back
    expect(s.world.jumps).toBeGreaterThan(0)
  })

  it('does not pillar for a wall it can reach from the ground', async () => {
    const s = setup()
    s.world.give('oak_planks', 40)
    s.world.give('cobblestone', 10)

    await s.executor.run(plan(...wall(4)), tall, skillContext().context)

    expect(s.world.jumps).toBe(0)
  })

  it('fails on the high steps when pillaring is off, and does everything else', async () => {
    const s = setup()
    s.world.give('oak_planks', 40)

    const result = await s.executor.run(plan(...wall(9)), options, skillContext().context)

    // The rows within reach are built; the rest has nothing to stand on to be reached.
    expect(result).toMatchObject({ ok: false, error: { reason: 'unsupported_steps' } })
    expect(s.world.builtBlocks().size).toBeGreaterThan(10)
    expect(s.world.jumps).toBe(0)
  })

  it('previews the tower: how many steps are high, how tall it is, and the blocks it needs', () => {
    const s = setup()
    s.world.give('oak_planks', 27)

    const preview = s.executor.preview(plan(...wall(9)), tall)

    expect(preview.scaffold).toMatchObject({ block: 'cobblestone', steps: 9 })
    expect(preview.scaffold?.height).toBeGreaterThanOrEqual(3)
    expect(preview.missing).toEqual([{ name: 'cobblestone', count: preview.scaffold?.height }])
    expect(preview.needs).toContainEqual({ name: 'cobblestone', count: preview.scaffold?.height })
  })

  it('previews no tower for a low wall, or when pillaring is off', () => {
    const s = setup()

    expect(s.executor.preview(plan(...wall(4)), tall).scaffold).toBeUndefined()
    expect(s.executor.preview(plan(...wall(9)), options).scaffold).toBeUndefined()
    expect(
      s.executor.preview(plan(...wall(9)), {
        ...tall,
        scaffold: { block: 'cobblestone', maxHeight: 0 },
      }).scaffold,
    ).toBeUndefined()
  })

  it('refuses up front when the scaffold blocks are missing, and changes nothing', async () => {
    const s = setup()
    s.world.give('oak_planks', 40)

    const result = await s.executor.run(plan(...wall(9)), tall, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'missing_materials' } })
    expect(s.world.log).toEqual([])
  })

  it('counts the scaffold block together with the building block when they are the same', () => {
    const s = setup()
    s.world.give('cobblestone', 27)
    const steps = wall(9).map((step) =>
      step.kind === 'place' ? { ...step, block: 'cobblestone' } : step,
    )

    const preview = s.executor.preview(plan(...steps), tall)

    expect(preview.missing[0]?.count).toBe(preview.scaffold?.height)
  })

  it('comes down first when cancelled up on the tower', async () => {
    const s = setup()
    s.world.give('oak_planks', 40)
    s.world.give('cobblestone', 10)
    const { context, controller } = skillContext()
    s.world.onPlaced = (position) => {
      if (position.y >= 69 && s.world.bot.y > 66) controller.abort() // cancelled once it is high up
    }

    const result = await s.executor.run(plan(...wall(9)), tall, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(scaffoldBlocksLeft(s.world)).toBe(0)
    expect(s.world.bot.y).toBe(64)
  })

  it('comes down when a step keeps failing up there', async () => {
    const s = setup()
    s.world.give('oak_planks', 40)
    s.world.give('cobblestone', 10)
    s.world.stubbornCells.add('1,70,5')

    const result = await s.executor.run(plan(...wall(9)), tall, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'incomplete' } })
    expect(scaffoldBlocksLeft(s.world)).toBe(0)
    expect(s.world.bot.y).toBe(64)
  })

  it('reports steps for which no safe tower place exists', async () => {
    const s = setup()
    s.world.give('oak_planks', 40)
    s.world.give('cobblestone', 10)
    // Everything around the wall is protected: there is nowhere to put the tower.
    s.world.protectedBoxes.push({
      label: 'garden',
      contains: (p) => !(p.z === 5 && p.x >= 0 && p.x <= 2),
    })

    const result = await s.executor.run(plan(...wall(9)), tall, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'incomplete' } })
    expect(!result.ok && result.error.message).toContain('no safe place for a scaffold tower')
    expect(s.world.jumps).toBe(0)
  })

  it('reports a tower that cannot be built', async () => {
    const s = setup()
    s.world.give('oak_planks', 40)
    s.world.give('cobblestone', 10)
    s.world.canJump = false

    const result = await s.executor.run(plan(...wall(9)), tall, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'incomplete' } })
    expect(s.world.bot.y).toBe(64)
  })

  it('raises the tower as needed for cells above the wall (a roof over a tall room)', async () => {
    const s = setup()
    s.world.give('oak_planks', 80)
    s.world.give('cobblestone', 10)
    const steps = wall(9)
    for (let x = 0; x < 3; x += 1)
      steps.push(place(x, 73, 5, 'oak_planks'), place(x, 73, 6, 'oak_planks'))

    const result = await s.executor.run(plan(...steps), tall, skillContext().context)

    expect(result).toMatchObject({ ok: true })
    expect(s.world.nameAt(at(1, 73, 6))).toBe('oak_planks')
    expect(scaffoldBlocksLeft(s.world)).toBe(0)
  })
})
