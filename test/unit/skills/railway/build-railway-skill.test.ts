import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import type { ItemCount } from '../../../../src/core/recipes.port.js'
import { err, ok } from '../../../../src/core/result.js'
import type { SkillResult } from '../../../../src/core/skill.types.js'
import type { MaterialFetcher } from '../../../../src/skills/building/material-fetcher.js'
import type {
  PlanExecutor,
  PlanOutcome,
  PlanPreview,
} from '../../../../src/skills/construction/plan-executor.js'
import {
  BuildRailwaySkill,
  type RailwayInput,
} from '../../../../src/skills/railway/build-railway-skill.js'
import { RailRoutePlanner } from '../../../../src/skills/railway/rail-route-planner.js'
import type { RailVerifier, Verification } from '../../../../src/skills/railway/rail-verifier.js'
import { RailwayLog } from '../../../../src/state/railway-log.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeEntityScanner, FakeVitals } from '../../../fakes/fake-ports.js'
import { FakeAreaGuard, skillContext } from '../../../fakes/gathering-fakes.js'
import { GroveWorld } from '../../../fakes/grove-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const GROUND = 63
const at = (x: number, y: number, z: number): Position => ({ x, y, z })

const preview = (over: Partial<PlanPreview> = {}): PlanPreview => ({
  steps: 30,
  toPlace: 25,
  toBreak: 3,
  alreadyDone: 0,
  needs: [],
  missing: [],
  torchesWanted: 0,
  blocked: [],
  blockedCount: 0,
  protectedArea: undefined,
  hazards: [],
  optionalMissing: [],
  warnings: [],
  scaffold: undefined,
  ...over,
})

const outcome = (over: Partial<PlanOutcome> = {}): PlanOutcome => ({
  steps: 30,
  placed: 25,
  broken: 3,
  lights: 0,
  alreadyDone: 0,
  used: [],
  ended: [],
  missingOptional: [],
  ...over,
})

class StubExecutor {
  previewResult = preview()
  runResult: SkillResult<PlanOutcome> = ok(outcome())
  readonly ran: unknown[] = []
  preview(): PlanPreview {
    return this.previewResult
  }
  run(plan: unknown): Promise<SkillResult<PlanOutcome>> {
    this.ran.push(plan)
    return Promise.resolve(this.runResult)
  }
}

const goodVerification: Verification = { checked: 11, problems: [], repaired: 0 }

async function setup() {
  const world = new GroveWorld({ x0: -30, x1: 60, z0: -30, z1: 30, y0: 30, y1: 110 })
  world.ground(-30, -30, 60, 30, GROUND)
  const vitals = new FakeVitals()
  vitals.vitals = {
    health: 20,
    food: 20,
    saturation: 5,
    oxygen: 20,
    inLava: false,
    inWater: false,
    headUnderwater: false,
    position: at(0.5, GROUND + 1, 0.5),
    dimension: 'overworld',
    timeOfDay: 0,
  }
  const executor = new StubExecutor()
  const entities = new FakeEntityScanner()
  const verified: unknown[] = []
  const verifier = {
    verify: (line: unknown) => {
      verified.push(line)
      return Promise.resolve(goodVerification)
    },
  }
  const fetched: (readonly ItemCount[])[] = []
  const fetcher: MaterialFetcher = {
    fetch: (missing) => {
      fetched.push(missing)
      return Promise.resolve()
    },
  }
  const log = new RailwayLog(new FakeClock(0))
  await log.attach(new InMemoryStateStore())
  const skill = new BuildRailwaySkill({
    planner: new RailRoutePlanner({ blocks: world, guard: new FakeAreaGuard() }),
    blocks: world,
    executor: executor as unknown as PlanExecutor,
    vitals,
    entities,
    verifier: verifier as unknown as RailVerifier,
    log,
    fetcher,
  })
  return { world, vitals, executor, entities, verified, fetched, log, skill }
}

const input = (over: Partial<RailwayInput> = {}): RailwayInput => ({
  from: undefined,
  to: at(10, GROUND + 1, 0),
  toPlayer: undefined,
  layout: 'surface',
  variant: 'economy',
  spacing: undefined,
  depth: undefined,
  supportBlock: 'cobblestone',
  label: undefined,
  fetchFromStorage: true,
  verify: true,
  ...over,
})

function previewOf(result: SkillResult<unknown>) {
  if (!result.ok) throw new Error(`${result.error.reason}: ${result.error.message}`)
  return result.value as Record<string, unknown>
}

describe('BuildRailwaySkill: preview', () => {
  it('reports the route and the layout without laying anything, starting at the bot', async () => {
    const s = await setup()
    s.executor.previewResult = preview({ missing: [{ name: 'rail', count: 20 }, { name: 'powered_rail', count: 4 }] })

    const result = previewOf(s.skill.preview(input()))

    expect(result).toMatchObject({
      start: at(0, GROUND + 1, 0),
      end: at(10, GROUND + 1, 0),
      layout: 'surface',
      variant: 'economy',
      rails: 11,
      corners: [],
      slopes: 0,
      cuts: 0,
      decks: 0,
      poweredRails: 4,
      torches: 1,
      buffer: at(-1, GROUND + 1, 0),
      notes: [],
    })
    expect(result['crafting']).toEqual([
      { name: 'gold_ingot', count: 6 },
      { name: 'iron_ingot', count: 12 },
      { name: 'redstone', count: 1 },
      { name: 'stick', count: 3 },
    ])
    expect(typeof result['estimatedMinutes']).toBe('number')
    expect(s.executor.ran).toEqual([])
  })

  it('moves a start and an end given as coordinates to the ground there', async () => {
    const s = await setup()

    const result = previewOf(s.skill.preview(input({ from: at(2, GROUND - 1, 2), to: at(12, GROUND + 3, 2) })))

    expect(result).toMatchObject({ start: at(2, GROUND + 1, 2), end: at(12, GROUND + 1, 2) })
  })

  it('ends at where a player stands', async () => {
    const s = await setup()
    s.entities.players.set('alex', { name: 'Alex', online: true, position: at(9.6, GROUND + 1, 0.2), distance: 9 })

    const result = previewOf(s.skill.preview(input({ to: undefined, toPlayer: 'alex' })))

    expect(result).toMatchObject({ end: at(9, GROUND + 1, 0) })
  })

  it.each([
    ['is not online', undefined, 'player_not_online'],
    ['is out of view', { name: 'Alex', online: true, position: undefined, distance: undefined }, 'player_not_visible'],
  ])('says when the player %s', async (_name, player, reason) => {
    const s = await setup()
    if (player !== undefined) s.entities.players.set('alex', player)

    const result = s.skill.preview(input({ to: undefined, toPlayer: 'alex' }))

    expect(result).toMatchObject({ ok: false, error: { reason } })
  })

  it('needs a destination', async () => {
    const s = await setup()

    expect(s.skill.preview(input({ to: undefined }))).toMatchObject({ ok: false, error: { reason: 'no_destination' } })
  })

  it.each([6, 11])('refuses a spacing of %s', async (spacing) => {
    const s = await setup()

    expect(s.skill.preview(input({ spacing }))).toMatchObject({ ok: false, error: { reason: 'invalid_spacing' } })
  })

  it('accepts spacings from 7 to 10 and uses them', async () => {
    const s = await setup()

    const result = previewOf(s.skill.preview(input({ spacing: 7, to: at(30, GROUND + 1, 0) })))

    expect(result['poweredRails']).toBe(4 + 3) // the start run, then every seventh: rails 10, 17, and 24
  })

  it('fails when not connected', async () => {
    const s = await setup()
    s.vitals.vitals = undefined

    expect(s.skill.preview(input())).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
  })

  it('passes on why no route was found, with where', async () => {
    const s = await setup()

    const result = s.skill.preview(input({ to: at(500, GROUND + 1, 0) }))

    expect(result).toMatchObject({ ok: false, error: { reason: 'too_long' } })
    const blocked = await setup()
    for (let z = -30; z <= 30; z += 1) blocked.world.set(5, GROUND, z, 'lava')
    expect(blocked.skill.preview(input())).toMatchObject({ ok: false, error: { reason: 'no_route' } })
    // An end that cannot be used says where.
    blocked.world.set(10, GROUND, 0, 'lava')
    expect(blocked.skill.preview(input())).toMatchObject({ ok: false, error: { reason: 'lava', detail: { at: at(10, GROUND + 1, 0) } } })
  })

  it('counts corners and slopes', async () => {
    const s = await setup()
    for (const z of [-2, -1, 0, 1, 2]) s.world.set(5, GROUND, z, 'stone_bricks')

    const result = previewOf(s.skill.preview(input()))

    expect((result['corners'] as unknown[]).length).toBeGreaterThanOrEqual(2)
  })
})

describe('BuildRailwaySkill: run', () => {
  it('lays the line, checks it, remembers it, and reports all of it', async () => {
    const s = await setup()

    const result = await s.skill.run(input({ label: 'mine line' }), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { rails: 11, placed: 25, verification: goodVerification, id: 'railway-1', fetched: [] },
    })
    expect(s.executor.ran).toHaveLength(1)
    expect(s.verified).toHaveLength(1)
    expect(s.log.latest()).toMatchObject({ label: 'mine line', start: at(0, GROUND + 1, 0), end: at(10, GROUND + 1, 0), rails: 11 })
  })

  it('does not check when told not to', async () => {
    const s = await setup()

    const result = await s.skill.run(input({ verify: false }), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { verification: undefined } })
    expect(s.verified).toEqual([])
  })

  it('fetches what is missing from storage first, unless told not to', async () => {
    const s = await setup()
    s.executor.previewResult = preview({ missing: [{ name: 'rail', count: 5 }] })

    const withStorage = await s.skill.run(input(), skillContext().context)
    const without = await s.skill.run(input({ fetchFromStorage: false }), skillContext().context)

    expect(s.fetched).toEqual([[{ name: 'rail', count: 5 }]])
    expect(withStorage).toMatchObject({ ok: true, value: { fetched: [{ name: 'rail', count: 5 }] } })
    expect(without).toMatchObject({ ok: true, value: { fetched: [] } })
  })

  it('says what to craft when materials run out', async () => {
    const s = await setup()
    s.executor.previewResult = preview({ missing: [{ name: 'rail', count: 20 }] })
    s.executor.runResult = err({ reason: 'missing_materials', message: 'Missing rail.', detail: { missing: [] } })

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({
      ok: false,
      error: {
        reason: 'missing_materials',
        message: expect.stringContaining('12 iron_ingot, 2 stick'),
        detail: { rails: 11, layout: 'surface' },
      },
    })
    expect(s.log.all()).toEqual([])
  })

  it('passes on another failure as it is', async () => {
    const s = await setup()
    s.executor.runResult = err({ reason: 'stuck', message: 'Several steps in a row failed.' })

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'stuck', message: 'Several steps in a row failed.' } })
  })

  it('fails as incomplete, with where, when a cut ended the line', async () => {
    const s = await setup()
    s.executor.runResult = ok(outcome({ ended: [{ branch: 'line', reason: 'hit_water', at: at(5, GROUND + 1, 0), skipped: 12 }] }))

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({
      ok: false,
      error: {
        reason: 'line_incomplete',
        message: expect.stringContaining('at 5, 64, 0'),
        detail: { ended: [expect.objectContaining({ reason: 'hit_water' })] },
      },
    })
    expect(s.verified).toEqual([])
    expect(s.log.all()).toEqual([])
  })

  it('reports an ended line with no place', async () => {
    const s = await setup()
    s.executor.runResult = ok(outcome({ ended: [{ branch: 'line', reason: 'unloaded', at: undefined, skipped: 3 }] }))

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'line_incomplete' } })
  })

  it('still succeeds when the line cannot be remembered (no world)', async () => {
    const s = await setup()
    s.log.detach()

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { id: undefined } })
  })

  it('does not run when there is no route', async () => {
    const s = await setup()

    const result = await s.skill.run(input({ to: undefined }), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_destination' } })
    expect(s.executor.ran).toEqual([])
  })
})
