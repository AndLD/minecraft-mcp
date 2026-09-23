import { describe, expect, it } from '@jest/globals'
import type { TillFailure, Tiller } from '../../../../src/core/tiller.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { err, ok, type Result } from '../../../../src/core/result.js'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import { PlanExecutor, type PlanOptions } from '../../../../src/skills/construction/plan-executor.js'
import { SiteSafety } from '../../../../src/skills/construction/site-safety.js'
import { StandingSpotChooser } from '../../../../src/skills/construction/standing-spot.js'
import type { WorkPlan, WorkStep } from '../../../../src/skills/construction/work-plan.types.js'
import { ConstructionWorld } from '../../../fakes/construction-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { AutoScheduler, FakeDroppedItems, skillContext } from '../../../fakes/gathering-fakes.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })
const till = (x: number, y: number, z: number): WorkStep => ({ kind: 'till', at: at(x, y, z) })
const plan = (...steps: WorkStep[]): WorkPlan => ({ name: 'test field', steps })
const options: PlanOptions = { clearObstacles: false }

/** Tills at once (turns the cell to farmland), unless configured to fail. */
class FakeTiller implements Tiller {
  readonly calls: Position[] = []
  failure: TillFailure | undefined

  constructor(private readonly world: ConstructionWorld) {}

  till(position: Position, _signal: AbortSignal): Promise<Result<void, TillFailure>> {
    this.calls.push(position)
    if (this.failure !== undefined) return Promise.resolve(err(this.failure))
    this.world.setBlock(position, 'farmland')
    return Promise.resolve(ok(undefined))
  }
}

function setup() {
  const world = new ConstructionWorld()
  const clock = new FakeClock(0)
  const scheduler = new AutoScheduler(clock)
  const drops = new DropCollector({ drops: new FakeDroppedItems(), navigator: world, scheduler })
  const tiller = new FakeTiller(world)
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
    tiller,
  })
  return { world, executor, tiller }
}

describe('PlanExecutor: till', () => {
  it('tills every cell into farmland', async () => {
    const s = setup()

    const result = await s.executor.run(plan(till(0, 63, 0), till(1, 63, 0)), options, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { steps: 2, placed: 2 } })
    expect(s.world.blockAt(at(0, 63, 0))).toBe('farmland')
    expect(s.world.blockAt(at(1, 63, 0))).toBe('farmland')
    expect(s.tiller.calls).toEqual([at(0, 63, 0), at(1, 63, 0)])
  })

  it('skips a cell that is already farmland', async () => {
    const s = setup()
    s.world.setBlock(at(0, 63, 0), 'farmland')

    const result = await s.executor.run(plan(till(0, 63, 0)), options, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { alreadyDone: 1, placed: 0 } })
    expect(s.tiller.calls).toEqual([])
  })

  it('previews an untilled cell as needing work, done once it is farmland', () => {
    const s = setup()

    const before = s.executor.preview(plan(till(0, 63, 0)), options)
    expect(before).toMatchObject({ toPlace: 1, alreadyDone: 0 })

    s.world.setBlock(at(0, 63, 0), 'farmland')
    const after = s.executor.preview(plan(till(0, 63, 0)), options)
    expect(after).toMatchObject({ toPlace: 0, alreadyDone: 1 })
  })

  it('fails with missing_materials when there is no hoe', async () => {
    const s = setup()
    s.tiller.failure = { reason: 'no_hoe', message: 'The bot has no hoe to till with.' }

    const result = await s.executor.run(plan(till(0, 63, 0)), options, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'missing_materials' } })
  })

  it('fails with missing_materials when no tiller is wired in at all', async () => {
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
    })

    const result = await executor.run(plan(till(0, 63, 0)), options, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'missing_materials' } })
  })

  it('retries a till that failed for another reason, and eventually gives up', async () => {
    const s = setup()
    s.tiller.failure = { reason: 'failed', message: 'busy' }

    const result = await s.executor.run(plan(till(0, 63, 0)), options, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'incomplete' } })
    expect(s.tiller.calls.length).toBeGreaterThan(1)
  })
})
