import { describe, expect, it } from '@jest/globals'
import { err, ok } from '../../../../src/core/result.js'
import type { SkillResult } from '../../../../src/core/skill.types.js'
import { FishSkill, type FishInput } from '../../../../src/skills/fishing/fish-skill.js'
import type { ItemSmelter, SmeltOutput } from '../../../../src/skills/smelting/smelt-items-skill.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeVitals } from '../../../fakes/fake-ports.js'
import {
  at,
  fishingWorld,
  FishingScheduler,
  GROUND,
  RecordingGaze,
  ScriptedFisher,
} from '../../../fakes/fishing-fakes.js'
import { FakeAreaGuard, InstantNavigator, skillContext } from '../../../fakes/gathering-fakes.js'

function setup(carried: Record<string, number> = { fishing_rod: 1 }) {
  const w = fishingWorld(carried)
  const clock = new FakeClock(0)
  const scheduler = new FishingScheduler(clock)
  const navigator = new InstantNavigator()
  const gaze = new RecordingGaze()
  const fisher = new ScriptedFisher()
  fisher.onCatch = (item) => {
    w.give(item)
  }
  fisher.onWaiting = () => {
    scheduler.expire()
  }
  const vitals = new FakeVitals()
  vitals.vitals = { position: at(0.5, GROUND + 1, 2.5) } as never
  const guard = new FakeAreaGuard()
  const smelted: { item: string; count: number | undefined }[] = []
  const smelter: ItemSmelter & { failWith?: string } = {
    run: (input) => {
      smelted.push({ item: input.item, count: input.count })
      if (smelter.failWith !== undefined)
        return Promise.resolve(err({ reason: 'no_fuel', message: smelter.failWith }))
      const output: SmeltOutput = {
        item: input.item,
        produced: `cooked_${input.item}`,
        smelted: input.count ?? 0,
        fuel: 'coal',
        requested: input.count ?? 0,
        station: 'furnace',
        fuelUsed: [],
        pending: 0,
        furnace: { x: 0, y: 64, z: 0 },
      }
      return Promise.resolve(ok(output) as SkillResult<SmeltOutput>)
    },
  }
  const skill = new FishSkill({
    blocks: w.world,
    navigator,
    gaze,
    fisher,
    inventory: w.inventory,
    vitals,
    guard,
    scheduler,
    clock,
    smelter,
  })
  return { ...w, clock, scheduler, navigator, gaze, fisher, vitals, guard, smelted, smelter, skill }
}

const input = (over: Partial<FishInput> = {}): FishInput => ({
  count: 3,
  item: undefined,
  maxMinutes: 10,
  cook: false,
  at: undefined,
  ...over,
})

describe('FishSkill', () => {
  it('walks to the shore, faces the water, and fishes until it has enough', async () => {
    const s = setup()

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { stopped: 'count', caught: 3, fish: 3, casts: 3 },
    })
    expect(s.navigator.trips).toHaveLength(1)
    expect(s.gaze.looked).toHaveLength(3)
    expect(s.gaze.looked[0]?.y).toBe(GROUND + 1)
    expect(result.ok && result.value.gained).toContainEqual({ name: 'cod', count: 3 })
  })

  it('sorts what comes up into fish, treasure, and junk, and keeps all of it', async () => {
    const s = setup()
    s.fisher.script.push(
      { bite: ['salmon'] },
      { bite: ['saddle'] },
      { bite: ['stick'] },
      { bite: ['cod'] },
    )

    const result = await s.skill.run(input({ count: 2 }), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { stopped: 'count', caught: 2, fish: 2, treasure: 1, junk: 1, casts: 4 },
    })
    expect(s.items.get('saddle')).toBe(1)
  })

  it('counts only the wanted item when one is named', async () => {
    const s = setup()
    s.fisher.script.push(
      { bite: ['cod'] },
      { bite: ['salmon'] },
      { bite: ['cod'] },
      { bite: ['salmon'] },
    )

    const result = await s.skill.run(input({ count: 2, item: 'salmon' }), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { caught: 2, fish: 4, casts: 4 } })
  })

  it('reels in and casts again when a cast never bites', async () => {
    const s = setup()
    s.fisher.script.push('never', 'never', { bite: ['cod'] })

    const result = await s.skill.run(input({ count: 1 }), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { stopped: 'count', caught: 1, casts: 3 } })
  })

  it('stops when the time is up', async () => {
    const s = setup()
    s.fisher.script.push('never', 'never', 'never', 'never')

    const result = await s.skill.run(input({ count: 5, maxMinutes: 2 }), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { stopped: 'time', caught: 0 } })
  })

  it('stops with what it has when the rod breaks', async () => {
    const s = setup()
    s.fisher.onCatch = (item) => {
      s.give(item)
      s.items.delete('fishing_rod')
      s.sync()
    }

    const result = await s.skill.run(input({ count: 5 }), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { stopped: 'rod_broke', caught: 1 } })
  })

  it('stops when there is no room for the catch', async () => {
    const s = setup()
    s.setEmptySlots(0)

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { stopped: 'inventory_full', casts: 0 } })
  })

  it('gives up after three casts in a row that fail', async () => {
    const s = setup()
    s.fisher.script.push({ fail: 'failed' }, { fail: 'failed' }, { fail: 'failed' })

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { stopped: 'cast_failed', casts: 3 } })
  })

  it('a failed cast between good ones does not add up', async () => {
    const s = setup()
    s.fisher.script.push(
      { fail: 'failed' },
      { bite: ['cod'] },
      { fail: 'failed' },
      { bite: ['cod'] },
    )

    const result = await s.skill.run(input({ count: 2 }), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { stopped: 'count', caught: 2 } })
  })

  it('bakes the raw fish when asked, and reports a cooking problem without failing', async () => {
    const s = setup()
    s.fisher.script.push({ bite: ['cod'] }, { bite: ['salmon'] })

    const cooked = await s.skill.run(input({ count: 2, cook: true }), skillContext().context)

    expect(s.smelted).toEqual([
      { item: 'cod', count: 1 },
      { item: 'salmon', count: 1 },
    ])
    expect(cooked).toMatchObject({
      ok: true,
      value: {
        cooked: [
          { name: 'cooked_cod', count: 1 },
          { name: 'cooked_salmon', count: 1 },
        ],
      },
    })

    const other = setup()
    other.smelter.failWith = 'no fuel'
    const problem = await other.skill.run(input({ count: 1, cook: true }), skillContext().context)
    expect(problem).toMatchObject({ ok: true, value: { caught: 1, cookProblem: 'cod: no fuel' } })
  })

  it('fails without a rod and says how to make one', async () => {
    const s = setup({})

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_rod' } })
    expect(!result.ok && result.error.message).toContain('3 sticks and 2 string')
    expect(s.navigator.trips).toHaveLength(0)
  })

  it('fails when the bot is not connected', async () => {
    const s = setup()
    s.vitals.vitals = undefined

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
  })

  it('fails no_water when there is no suitable water, and says what to try', async () => {
    const s = setup()
    s.world.ground(-30, -30, 30, 30, GROUND)

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_water' } })
    expect(!result.ok && result.error.message).toContain('at')
  })

  it('fails unreachable when the shore cannot be reached', async () => {
    const s = setup()
    s.navigator.failures = [{ reason: 'unreachable', message: 'blocked' }]

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'unreachable' } })
  })

  it('goes to the given place first', async () => {
    const s = setup()

    await s.skill.run(input({ count: 1, at: at(5, GROUND + 1, 2) }), skillContext().context)

    expect(s.navigator.trips[0]).toMatchObject({ target: at(5, GROUND + 1, 2), within: 6 })
    expect(s.navigator.trips).toHaveLength(2)
  })

  it('fails when the given place cannot be reached', async () => {
    const s = setup()
    s.navigator.failures = [{ reason: 'unreachable', message: 'blocked' }]

    const result = await s.skill.run(input({ at: at(5, GROUND + 1, 2) }), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'unreachable' } })
  })

  it('reports what it caught when it is cancelled between casts, and while waiting for a bite', async () => {
    const between = setup()
    const context = skillContext()
    between.fisher.onCatch = (item) => {
      between.give(item)
      context.controller.abort()
    }
    const result = await between.skill.run(input({ count: 5 }), context.context)
    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted', detail: { casts: 1 } } })

    const waiting = setup()
    const other = skillContext()
    waiting.fisher.script.push('never')
    waiting.fisher.onWaiting = () => {
      other.controller.abort()
    }
    const cancelled = await waiting.skill.run(input(), other.context)
    expect(cancelled).toMatchObject({ ok: false, error: { reason: 'aborted' } })
  })

  it('fails aborted when cancelled on the way to the water', async () => {
    const s = setup()
    const context = skillContext()
    context.controller.abort()

    const result = await s.skill.run(input(), context.context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
  })
})
