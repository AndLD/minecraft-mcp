import { describe, expect, it } from '@jest/globals'
import type { ItemCount } from '../../../../src/core/recipes.port.js'
import type { MaterialFetcher } from '../../../../src/skills/building/material-fetcher.js'
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
} from '../../../../src/skills/excavation/providers/dig-down.js'
import { TunnelProvider } from '../../../../src/skills/excavation/providers/tunnels.js'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import { buildVitals } from '../../../fakes/fake-ports.js'
import { ConstructionWorld } from '../../../fakes/construction-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { AutoScheduler, FakeDroppedItems, skillContext } from '../../../fakes/gathering-fakes.js'

class FakeFetcher implements MaterialFetcher {
  readonly asked: (readonly ItemCount[])[] = []
  constructor(
    private readonly onFetch: (missing: readonly ItemCount[]) => void = () => undefined,
  ) {}
  fetch(missing: readonly ItemCount[]): Promise<void> {
    this.asked.push(missing)
    this.onFetch(missing)
    return Promise.resolve()
  }
}

function setup(fetcher?: MaterialFetcher) {
  const world = new ConstructionWorld(63)
  const scheduler = new AutoScheduler(new FakeClock(0))
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
    .register(new QuarryProvider())
    .register(new TunnelProvider())
  const skill = new ExcavateSkill({
    registry,
    executor,
    vitals: world,
    ...(fetcher === undefined ? {} : { fetcher }),
  })
  return { world, skill }
}

const request = (patch: Partial<ExcavateInput> = {}): ExcavateInput => ({
  shape: 'pit',
  params: { width: 3, length: 3, depth: 2, exit: 'none' },
  origin: undefined,
  fetchFromStorage: true,
  ...patch,
})

describe('ExcavateSkill: digging', () => {
  it('digs a 3x3x2 pit starting at the ground block two blocks east of the bot', async () => {
    const s = setup()
    s.world.bot = { x: 5.5, y: 64, z: 5.5 }

    const result = await s.skill.run(request(), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: {
        shape: 'pit 3x3x2',
        origin: { x: 7, y: 63, z: 5 },
        bounds: { from: { x: 7, y: 62, z: 5 }, to: { x: 9, y: 63, z: 7 } },
        broken: 18,
        ended: [],
        fetched: [],
      },
    })
    expect(s.world.nameAt({ x: 8, y: 63, z: 6 })).toBe('air')
    expect(s.world.nameAt({ x: 8, y: 62, z: 6 })).toBe('air')
    expect(s.world.nameAt({ x: 8, y: 61, z: 6 })).toBe('dirt')
    expect(s.world.nameAt({ x: 6, y: 63, z: 6 })).toBe('dirt') // outside stays
  })

  it('digs at a given origin', async () => {
    const s = setup()

    await s.skill.run(request({ origin: { x: 30, y: 63, z: 30 } }), skillContext().context)

    expect(s.world.nameAt({ x: 31, y: 62, z: 31 })).toBe('air')
  })

  it('never digs a protected area', async () => {
    const s = setup()
    s.world.protectedBoxes.push({ label: 'house', contains: () => true })

    const result = await s.skill.run(request(), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'protected_area' } })
  })
})

describe('ExcavateSkill: refusing', () => {
  it('names the known shapes for an unknown one', async () => {
    const s = setup()

    const result = await s.skill.run(request({ shape: 'moat' }), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'unknown_shape' } })
    expect(!result.ok && result.error.message).toContain('pit, quarry, tunnel')
  })

  it('names the wrong parameters', async () => {
    const s = setup()

    const result = await s.skill.run(
      request({ params: { width: 0, length: 'x' } }),
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'invalid_params' } })
    expect(!result.ok && result.error.message).toContain('width')
    expect(!result.ok && result.error.message).toContain('list_excavations')
  })

  it('reports a shape that cannot be dug, in words', async () => {
    const s = setup()

    const result = await s.skill.run(
      request({ shape: 'quarry', params: { width: 2, length: 2, to_y: 70 } }),
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'invalid_shape' } })
    expect(!result.ok && result.error.message).toContain('above where the dig starts')
  })

  it('needs a connection', async () => {
    const s = setup()
    s.world.read = () => undefined

    expect(await s.skill.run(request(), skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'not_connected' },
    })
  })

  it('counts the bottom of the Nether from 0', () => {
    const s = setup()
    s.world.read = () =>
      buildVitals({ position: { x: 0.5, y: 64, z: 0.5 }, dimension: 'the_nether' })

    const preview = s.skill.preview(request({ shape: 'quarry', params: { width: 2, length: 2 } }))

    expect(preview.ok && preview.value.bounds.from.y).toBe(9) // 9 above the lowest layer, which is 0 there
  })
})

describe('ExcavateSkill: materials', () => {
  it('reports missing ladders and torches like any other material, with a hint', async () => {
    const s = setup()

    const result = await s.skill.run(
      request({ params: { width: 3, length: 3, depth: 3 } }),
      skillContext().context,
    )

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'missing_materials', detail: { missing: [{ name: 'ladder', count: 3 }] } },
    })
    expect(!result.ok && result.error.message).toContain('craft or fetch')
    expect(s.world.log).toEqual([])
  })

  it('fetches the ladders from the containers, then digs', async () => {
    const fetcher = new FakeFetcher((missing) => {
      for (const m of missing) world.give(m.name, m.count)
    })
    const { world, skill } = setup(fetcher)

    const result = await skill.run(
      request({ params: { width: 3, length: 3, depth: 3 } }),
      skillContext().context,
    )

    expect(fetcher.asked).toEqual([[{ name: 'ladder', count: 3 }]])
    expect(result).toMatchObject({ ok: true, value: { fetched: [{ name: 'ladder', count: 3 }] } })
  })

  it('does not fetch when told not to', async () => {
    const fetcher = new FakeFetcher()
    const { skill } = setup(fetcher)

    await skill.run(
      request({ params: { width: 3, length: 3, depth: 3 }, fetchFromStorage: false }),
      skillContext().context,
    )

    expect(fetcher.asked).toEqual([])
  })
})

describe('ExcavateSkill.preview', () => {
  it('echoes the dimensions as understood, with defaults, and what it would take', () => {
    const s = setup()
    s.world.give('ladder', 1)

    const preview = s.skill.preview(
      request({ shape: 'quarry', params: { width: 5, length: 5, to_y: 60 } }),
    )

    expect(preview.ok).toBe(true)
    expect(preview.ok && preview.value).toMatchObject({
      shape: 'quarry 5x5 to y=60',
      interpreted: { width: 5, length: 5, to_y: 60, exit: 'ladder' },
      origin: { x: 2, y: 63, z: 0 },
      defaultOrigin: true,
      blocks: 100,
      estimatedMinutes: 1,
      missing: [{ name: 'ladder', count: 3 }],
      bounds: { from: { x: 2, y: 60, z: 0 }, to: { x: 6, y: 63, z: 4 } },
    })
    expect(s.world.log).toEqual([])
  })

  it('says how long a big quarry takes, and that the default target is 9 above the bedrock', () => {
    const s = setup()

    const preview = s.skill.preview(request({ shape: 'quarry', params: { width: 5, length: 5 } }))

    expect(preview.ok && preview.value).toMatchObject({
      shape: 'quarry 5x5 to y=-55',
      blocks: 5 * 5 * 119,
      interpreted: { exit: 'ladder' },
    })
    expect(preview.ok && preview.value.estimatedMinutes).toBeGreaterThan(30)
  })

  it('passes on parameter errors', () => {
    const s = setup()

    expect(s.skill.preview(request({ params: {} }))).toMatchObject({
      ok: false,
      error: { reason: 'invalid_params' },
    })
  })

  it('does not treat lava beside the site as a reason to refuse: the hazard rule handles it per block', () => {
    const s = setup()
    s.world.setBlock({ x: 6, y: 63, z: 5 }, 'lava')

    const preview = s.skill.preview(request())

    expect(preview.ok && preview.value.hazards).toEqual([])
  })
})
