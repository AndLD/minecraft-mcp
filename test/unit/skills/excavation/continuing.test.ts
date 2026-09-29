import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import type { WorkStep } from '../../../../src/skills/construction/work-plan.types.js'
import { HazardRule } from '../../../../src/skills/construction/hazard-rule.js'
import { PlanExecutor } from '../../../../src/skills/construction/plan-executor.js'
import { SiteSafety } from '../../../../src/skills/construction/site-safety.js'
import { StandingSpotChooser } from '../../../../src/skills/construction/standing-spot.js'
import {
  ExcavateSkill,
  type ExcavateInput,
} from '../../../../src/skills/excavation/excavate-skill.js'
import { ExcavationRegistry } from '../../../../src/skills/excavation/excavation-registry.js'
import {
  PitProvider,
  QuarryProvider,
  ShaftProvider,
} from '../../../../src/skills/excavation/providers/dig-down.js'
import { TunnelProvider } from '../../../../src/skills/excavation/providers/tunnels.js'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import { ExcavationRecords } from '../../../../src/state/excavation-records.js'
import { ConstructionWorld } from '../../../fakes/construction-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { AutoScheduler, FakeDroppedItems, skillContext } from '../../../fakes/gathering-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })

async function setup() {
  const world = new ConstructionWorld(63)
  const clock = new FakeClock(0)
  const scheduler = new AutoScheduler(clock)
  const executor = new PlanExecutor({
    blocks: world,
    placer: world,
    digger: world,
    navigator: world,
    inventory: world,
    vitals: world,
    guard: world,
    drops: new DropCollector({ drops: new FakeDroppedItems(), navigator: world, scheduler }),
    spots: new StandingSpotChooser(world),
    safety: new SiteSafety(world, world),
    scheduler,
    hazard: new HazardRule(world),
  })
  const registry = new ExcavationRegistry()
    .register(new PitProvider())
    .register(new ShaftProvider())
    .register(new QuarryProvider())
    .register(new TunnelProvider())
  const records = new ExcavationRecords(clock)
  await records.attach(new InMemoryStateStore())
  const skill = new ExcavateSkill({ registry, executor, vitals: world, records, blocks: world })
  world.bot = at(5.5, 64, 5.5) // the origin of a default dig is (7, 63, 5)
  return { world, skill, records }
}

const quarry = (params: object, patch: Partial<ExcavateInput> = {}): ExcavateInput => ({
  shape: 'quarry',
  params: { width: 3, length: 3, to_y: 62, exit: 'stairs', ...params },
  origin: undefined,
  fetchFromStorage: false,
  ...patch,
})
const isOpen = (world: ConstructionWorld, p: Position): boolean =>
  ['air', 'ladder'].includes(world.nameAt(p))

describe('continuing a dig', () => {
  it('records a quarry, then extends it: deeper, with the stairs carried on', async () => {
    const s = await setup()
    const first = await s.skill.run(quarry({}), skillContext().context)
    expect(first).toMatchObject({ ok: true })
    expect(s.records.all()).toMatchObject([
      { shape: 'quarry', origin: at(7, 63, 5), width: 3, length: 3, bottom: 62, exit: 'stairs' },
    ])
    expect(isOpen(s.world, at(8, 60, 6))).toBe(false)

    s.world.bot = at(8.5, 62, 6.5) // inside the hole now
    const deeper = await s.skill.run(
      quarry({}, { continueExisting: true, params: { to_y: 60 } }),
      skillContext().context,
    )

    expect(deeper).toMatchObject({
      ok: true,
      value: {
        origin: at(7, 63, 5),
        continued: { existingLayers: 2, existingBottom: 62, targetBottom: 60, addLayers: 2 },
      },
    })
    for (const y of [63, 62, 61, 60]) expect(isOpen(s.world, at(8, y, 6))).toBe(true)
    // The step of the new layer 61 joins the one above it: the ring continues, one block lower.
    expect(isOpen(s.world, at(8, 61, 4))).toBe(true)
    expect(s.records.all()[0]?.bottom).toBe(60)
  })

  it('digs only what is missing: a second pass over the same hole does no work', async () => {
    const s = await setup()
    await s.skill.run(quarry({}), skillContext().context)
    const full = s.world.log.length

    const again = await s.skill.run(
      quarry({}, { continueExisting: true, params: {} }),
      skillContext().context,
    )

    expect(again).toMatchObject({ ok: true, value: { broken: 0, continued: { addLayers: 0 } } })
    expect(s.world.log.length).toBe(full)
  })

  it('says what it found and what it will add, in the preview too', async () => {
    const s = await setup()
    await s.skill.run(quarry({}), skillContext().context)

    const preview = s.skill.preview(quarry({}, { continueExisting: true, params: { to_y: 59 } }))

    expect(preview).toMatchObject({
      ok: true,
      value: {
        continuing: {
          shape: 'quarry',
          existingLayers: 2,
          addLayers: 3,
          summary: expect.stringContaining('3x3 quarry, 2 deep'),
        },
        origin: at(7, 63, 5),
        defaultOrigin: false,
      },
    })
    expect(s.world.log.filter((line) => line.startsWith('dig')).length).toBeGreaterThan(0)
  })

  it('continues a pit and a shaft with a new total depth', async () => {
    const s = await setup()
    await s.skill.run(
      {
        shape: 'pit',
        params: { width: 2, length: 2, depth: 2, exit: 'none' },
        origin: undefined,
        fetchFromStorage: false,
      },
      skillContext().context,
    )
    s.world.bot = at(7.5, 62, 5.5)

    const result = await s.skill.run(
      {
        shape: 'pit',
        params: { depth: 4 },
        origin: undefined,
        fetchFromStorage: false,
        continueExisting: true,
      },
      skillContext().context,
    )

    expect(result).toMatchObject({
      ok: true,
      value: { continued: { existingLayers: 2, addLayers: 2 } },
    })
    expect(isOpen(s.world, at(7, 60, 5))).toBe(true)
  })

  it('finds the dig by an origin given, wherever the bot is', async () => {
    const s = await setup()
    await s.skill.run(quarry({}), skillContext().context)
    s.world.bot = at(40.5, 64, 40.5)

    const result = await s.skill.run(
      quarry({}, { continueExisting: true, params: { to_y: 61 }, origin: at(7, 63, 5) }),
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { continued: { addLayers: 1 } } })
  })

  it('takes a target in the other unit over the recorded one', async () => {
    const s = await setup()
    await s.skill.run(quarry({}), skillContext().context)

    const preview = s.skill.preview(
      quarry({}, { continueExisting: true, params: { above_bedrock: 9 } }),
    )

    expect(preview).toMatchObject({ ok: true, value: { continuing: { targetBottom: -55 } } })
  })

  describe('refusals', () => {
    const refused = (result: unknown): void => {
      expect(result).toMatchObject({ ok: false, error: { reason: 'not_recognised' } })
    }

    it('with no record of a dig around', async () => {
      const s = await setup()

      refused(await s.skill.run(quarry({}, { continueExisting: true }), skillContext().context))
    })

    it('for a shape it does not keep records of', async () => {
      const s = await setup()

      refused(
        await s.skill.run(
          {
            shape: 'tunnel',
            params: { direction: 'north', length: 4 },
            origin: undefined,
            fetchFromStorage: false,
            continueExisting: true,
          },
          skillContext().context,
        ),
      )
    })

    it('when the dig found is another shape', async () => {
      const s = await setup()
      await s.skill.run(quarry({}), skillContext().context)

      refused(
        await s.skill.run(
          {
            shape: 'pit',
            params: { depth: 3 },
            origin: undefined,
            fetchFromStorage: false,
            continueExisting: true,
          },
          skillContext().context,
        ),
      )
    })

    it('when the recorded hole is no longer there', async () => {
      const s = await setup()
      await s.skill.run(quarry({}), skillContext().context)
      s.world.setBlock(at(7, 63, 5), 'dirt') // filled in again

      refused(await s.skill.run(quarry({}, { continueExisting: true }), skillContext().context))
    })

    it('when several digs are near, and lists them', async () => {
      const s = await setup()
      await s.skill.run(quarry({}), skillContext().context)
      const first = s.records.all()[0]
      if (first === undefined) throw new Error('no record')
      s.records.record({ ...first, origin: at(9, 63, 5) })
      s.world.setBlock(at(9, 63, 5), 'air')
      s.world.bot = at(9.5, 64, 5.5)

      const result = await s.skill.run(
        quarry({}, { continueExisting: true }),
        skillContext().context,
      )

      refused(result)
      expect(JSON.stringify(result)).toContain('Several digs are near')
    })

    it('when it cannot tell where to look (not connected)', async () => {
      const s = await setup()
      s.world.bot = at(8.5, 64, 5.5)
      const off = new ExcavateSkill({
        registry: new ExcavationRegistry().register(new QuarryProvider()),
        executor: (s.skill as unknown as { deps: { executor: PlanExecutor } }).deps.executor,
        vitals: { read: () => undefined },
        records: s.records,
        blocks: s.world,
      })

      const result = await off.run(quarry({}, { continueExisting: true }), skillContext().context)

      expect(result).toMatchObject({ ok: false })
    })

    it('without the record store wired', async () => {
      const s = await setup()
      const bare = new ExcavateSkill({
        registry: new ExcavationRegistry().register(new QuarryProvider()),
        executor: (s.skill as unknown as { deps: { executor: PlanExecutor } }).deps.executor,
        vitals: s.world,
      })

      refused(await bare.run(quarry({}, { continueExisting: true }), skillContext().context))
    })
  })
})

describe('cutting from the bottom up', () => {
  const generate = (order: 'top_down' | 'bottom_up', exit = 'stairs') => {
    const p = new QuarryProvider()
    const plan = p.generate(p.params.parse({ width: 3, length: 3, to_y: 60, exit, order }), {
      origin: at(7, 63, 5),
      minY: -64,
    })
    if ('error' in plan) throw new Error(plan.error)
    return plan
  }

  it('plans the layers from the lowest up, each cell needing the one below it', () => {
    const plan = generate('bottom_up', 'none')

    const breaks = plan.steps.filter((s) => s.kind === 'break')
    expect(breaks[0]?.at.y).toBe(60)
    expect(breaks.at(-1)?.at.y).toBe(63)
    for (const step of breaks) {
      if (step.at.y === 60) expect(step.needs).toBeUndefined()
      else expect(step.needs).toEqual({ x: step.at.x, y: step.at.y - 1, z: step.at.z })
    }
  })

  it('leaves the top-down plan as it was', () => {
    const plan = generate('top_down', 'none')

    const breaks = plan.steps.filter((s) => s.kind === 'break')
    expect(breaks[0]?.at.y).toBe(63)
    expect(breaks.every((s) => s.needs === undefined)).toBe(true)
  })

  it('cuts the stairs from the lowest step up, each joined to the one below', () => {
    const plan = generate('bottom_up')
    const stairs = plan.steps.filter(
      (s): s is Extract<WorkStep, { kind: 'break' }> => s.kind === 'break' && s.branch === 'stairs',
    )

    expect(stairs[0]?.at.y).toBeLessThan(stairs.at(-1)?.at.y ?? 0)
    const lowest = Math.min(...stairs.map((s) => s.at.y))
    // The lowest step's first cell needs nothing (the bot stands beside it in the hole)...
    expect(stairs.find((s) => s.at.y === lowest)?.needs).toBeUndefined()
    // ...and the first cell of the step above needs the cell of the step below it that is level with it.
    const second = stairs.find((s) => s.at.x === 8 && s.at.z === 4 && s.at.y === 61)
    expect(second?.needs).toEqual({ x: 9, y: 61, z: 4 })
  })

  it('does not probe below the cell, where the bot came from', () => {
    const plan = generate('bottom_up', 'none')
    const probe = plan.steps.find((s) => s.kind === 'break')?.probe

    expect(probe).toBeDefined()
    expect(probe).not.toContainEqual({ x: 0, y: -1, z: 0 })
    expect(probe).toContainEqual({ x: 0, y: 1, z: 0 })
  })

  it('cuts the stair walls of a finished quarry from its bottom, and the bot climbs out on them', async () => {
    const s = await setup()
    await s.skill.run(quarry({ exit: 'none', to_y: 60 }), skillContext().context)
    s.world.bot = at(8.5, 60, 6.5) // at the bottom

    const result = await s.skill.run(
      quarry({}, { continueExisting: true, params: { exit: 'stairs', order: 'bottom_up' } }),
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { ended: [], continued: { addLayers: 0 } } })
    expect(s.records.all()[0]?.exit).toBe('stairs')
    // Four steps: the ring cells (margin 1 around 7..9 x 5..7), one block lower each.
    const ring = [at(6, 63, 4), at(7, 62, 4), at(8, 61, 4), at(9, 60, 4)]
    for (const cell of ring)
      for (const dy of [0, 1, 2, 3])
        expect(isOpen(s.world, at(cell.x, cell.y + dy, cell.z))).toBe(true)
  })
})
