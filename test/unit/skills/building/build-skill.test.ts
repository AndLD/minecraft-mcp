import { describe, expect, it } from '@jest/globals'
import type { ItemCount } from '../../../../src/core/recipes.port.js'
import type { SkillContext } from '../../../../src/core/skill.types.js'
import { BlueprintRegistry } from '../../../../src/skills/building/blueprint-registry.js'
import { BuildSkill, type BuildInput } from '../../../../src/skills/building/build-skill.js'
import type { MaterialFetcher } from '../../../../src/skills/building/material-fetcher.js'
import { StorageMaterialFetcher } from '../../../../src/skills/building/material-fetcher.js'
import {
  BoxProvider,
  FloorProvider,
  SingleBlockProvider,
  WallsProvider,
} from '../../../../src/skills/building/providers/basic-providers.js'
import { PlanExecutor } from '../../../../src/skills/construction/plan-executor.js'
import { SiteSafety } from '../../../../src/skills/construction/site-safety.js'
import { StandingSpotChooser } from '../../../../src/skills/construction/standing-spot.js'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import { err, ok } from '../../../../src/core/result.js'
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
  const world = new ConstructionWorld()
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
  })
  const registry = new BlueprintRegistry()
    .register(new FloorProvider())
    .register(new WallsProvider())
    .register(new BoxProvider())
    .register(new SingleBlockProvider())
  const skill = new BuildSkill({
    registry,
    executor,
    vitals: world,
    ...(fetcher === undefined ? {} : { fetcher }),
  })
  return { world, skill }
}

const request = (patch: Partial<BuildInput> = {}): BuildInput => ({
  blueprint: 'floor',
  params: { width: 3, depth: 3, block: 'cobblestone' },
  origin: undefined,
  clearObstacles: false,
  fetchFromStorage: true,
  ...patch,
})

describe('BuildSkill: building', () => {
  it('builds the blueprint two blocks east of the bot by default, and says where', async () => {
    const s = setup()
    s.world.bot = { x: 10.5, y: 64, z: 20.5 }
    s.world.give('cobblestone', 9)

    const result = await s.skill.run(request(), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: {
        blueprint: 'floor 3x3',
        origin: { x: 12, y: 64, z: 20 },
        bounds: { from: { x: 12, y: 64, z: 20 }, to: { x: 14, y: 64, z: 22 } },
        placed: 9,
        fetched: [],
      },
    })
    expect(s.world.builtBlocks().size).toBe(9)
    expect(s.world.nameAt({ x: 12, y: 64, z: 20 })).toBe('cobblestone')
  })

  it('builds at the given origin', async () => {
    const s = setup()
    s.world.give('cobblestone', 9)

    await s.skill.run(request({ origin: { x: 40, y: 64, z: 40 } }), skillContext().context)

    expect(s.world.nameAt({ x: 42, y: 64, z: 42 })).toBe('cobblestone')
    expect(s.world.nameAt({ x: 12, y: 64, z: 0 })).toBe('air')
  })

  it('builds a closed box: floor, walls, and roof', async () => {
    const s = setup()
    s.world.give('cobblestone', 100)

    const result = await s.skill.run(
      request({
        blueprint: 'box',
        params: { width: 4, depth: 4, height: 2, wall_block: 'cobblestone' },
        origin: { x: 10, y: 64, z: 10 },
      }),
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { placed: 54 } })
    expect(s.world.nameAt({ x: 10, y: 64, z: 10 })).toBe('cobblestone') // floor
    expect(s.world.nameAt({ x: 10, y: 66, z: 10 })).toBe('cobblestone') // wall
    expect(s.world.nameAt({ x: 11, y: 66, z: 11 })).toBe('air') // inside
    expect(s.world.nameAt({ x: 11, y: 67, z: 11 })).toBe('cobblestone') // roof
  })

  it('is safe to run again: it finishes only what is missing', async () => {
    const s = setup()
    s.world.give('cobblestone', 9)
    const input = request({ origin: { x: 20, y: 64, z: 20 } })
    await s.skill.run(input, skillContext().context)
    s.world.setBlock({ x: 20, y: 64, z: 20 }, 'air')
    s.world.give('cobblestone', 1)

    const result = await s.skill.run(input, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { placed: 1, alreadyDone: 8 } })
  })
})

describe('BuildSkill: refusing', () => {
  it('names the known blueprints for an unknown one', async () => {
    const s = setup()

    const result = await s.skill.run(request({ blueprint: 'castle' }), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'unknown_blueprint' } })
    expect(!result.ok && result.error.message).toContain(
      'box, block, floor, walls'.split(', ').sort().join(', '),
    )
  })

  it('names the wrong parameters', async () => {
    const s = setup()

    const result = await s.skill.run(
      request({ params: { width: 0, depth: 'x' } }),
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'invalid_params' } })
    expect(!result.ok && result.error.message).toContain('width')
    expect(!result.ok && result.error.message).toContain('depth')
  })

  it('reports missing materials with a hint, and the origin it would have used', async () => {
    const s = setup()
    s.world.give('cobblestone', 4)

    const result = await s.skill.run(
      request({ origin: { x: 5, y: 64, z: 5 } }),
      skillContext().context,
    )

    expect(result).toMatchObject({
      ok: false,
      error: {
        reason: 'missing_materials',
        detail: { missing: [{ name: 'cobblestone', count: 5 }], origin: { x: 5, y: 64, z: 5 } },
      },
    })
    expect(!result.ok && result.error.message).toContain('gather, craft, or hunt')
    expect(s.world.builtBlocks().size).toBe(0)
  })

  it('needs a connection to work out the default origin', async () => {
    const s = setup()
    s.world.read = () => undefined

    expect(await s.skill.run(request(), skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'not_connected' },
    })
  })
})

describe('BuildSkill: fetching materials', () => {
  it('fetches what is missing from the containers, then builds', async () => {
    const fetcher = new FakeFetcher((missing) => {
      for (const m of missing) world.give(m.name, m.count)
    })
    const { world, skill } = setup(fetcher)
    world.give('cobblestone', 4)

    const result = await skill.run(
      request({ origin: { x: 5, y: 64, z: 5 } }),
      skillContext().context,
    )

    expect(fetcher.asked).toEqual([[{ name: 'cobblestone', count: 5 }]])
    expect(result).toMatchObject({
      ok: true,
      value: { placed: 9, fetched: [{ name: 'cobblestone', count: 5 }] },
    })
  })

  it('does not fetch when nothing is missing, or when told not to', async () => {
    const fetcher = new FakeFetcher()
    const { world, skill } = setup(fetcher)
    world.give('cobblestone', 20)
    await skill.run(request({ origin: { x: 5, y: 64, z: 5 } }), skillContext().context)
    expect(fetcher.asked).toEqual([])

    const other = new FakeFetcher()
    const second = setup(other)
    await second.skill.run(request({ fetchFromStorage: false }), skillContext().context)
    expect(other.asked).toEqual([])
  })

  it('still reports what could not be found', async () => {
    const fetcher = new FakeFetcher()
    const { skill } = setup(fetcher)

    const result = await skill.run(
      request({ origin: { x: 5, y: 64, z: 5 } }),
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'missing_materials' } })
  })
})

describe('BuildSkill.preview', () => {
  it('describes the job and changes nothing', () => {
    const s = setup()
    s.world.give('cobblestone', 4)
    s.world.bot = { x: 0.5, y: 64, z: 0.5 }

    const preview = s.skill.preview(request())

    expect(preview.ok).toBe(true)
    expect(preview.ok && preview.value).toMatchObject({
      blueprint: 'floor 3x3',
      origin: { x: 2, y: 64, z: 0 },
      defaultOrigin: true,
      toPlace: 9,
      missing: [{ name: 'cobblestone', count: 5 }],
      bounds: { to: { x: 4, y: 64, z: 2 } },
    })
    expect(s.world.log).toEqual([])
  })

  it('says the origin was given, and passes on parameter errors', () => {
    const s = setup()

    expect(s.skill.preview(request({ origin: { x: 1, y: 64, z: 1 } }))).toMatchObject({
      ok: true,
      value: { defaultOrigin: false },
    })
    expect(s.skill.preview(request({ params: {} }))).toMatchObject({
      ok: false,
      error: { reason: 'invalid_params' },
    })
  })
})

describe('StorageMaterialFetcher', () => {
  const context = skillContext().context

  /** `supplies`: the containers hand over what was asked for; otherwise they have nothing. */
  function fetcherOf(supplies: boolean | number) {
    const world = new ConstructionWorld()
    const calls: string[] = []
    const fetcher = new StorageMaterialFetcher({
      inventory: world,
      withdrawer: {
        run: (input) => {
          calls.push(
            `withdraw ${input.requests.map((r) => `${String(r.count)} ${r.item}`).join(',')}`,
          )
          if (supplies !== false)
            for (const r of input.requests)
              world.give(r.item, Math.min(r.count ?? 0, supplies === true ? Infinity : supplies))
          return Promise.resolve(ok({ withdrawn: [], shortfall: [] }))
        },
      },
      scanner: {
        run: () => {
          calls.push('scan')
          return Promise.resolve(ok({ scanned: 0 } as never))
        },
      },
    })
    return { world, calls, fetcher }
  }

  it('withdraws the missing items and stops when that was enough', async () => {
    const t = fetcherOf(true)

    await t.fetcher.fetch([{ name: 'stone', count: 10 }], context)

    expect(t.calls).toEqual(['withdraw 10 stone'])
  })

  it('looks into unopened containers when the known ones did not have enough, then asks again', async () => {
    const t = fetcherOf(false)
    t.world.give('stone', 4)

    await t.fetcher.fetch([{ name: 'stone', count: 10 }], context)

    expect(t.calls).toEqual(['withdraw 10 stone', 'scan', 'withdraw 10 stone'])
  })

  it('asks only for the part that is still missing after a first withdrawal', async () => {
    const t = fetcherOf(6) // the first container has only 6 of the 10
    t.world.give('stone', 4)

    await t.fetcher.fetch([{ name: 'stone', count: 10 }], context)

    expect(t.calls).toEqual(['withdraw 10 stone', 'scan', 'withdraw 4 stone'])
  })

  it('asks for nothing when nothing is missing', async () => {
    const t = fetcherOf(false)

    await t.fetcher.fetch([], context)

    expect(t.calls).toEqual([])
  })

  it('stops when cancelled', async () => {
    const t = fetcherOf(false)
    const controller = new AbortController()
    controller.abort()
    const cancelled: SkillContext = { signal: controller.signal, progress: () => undefined }

    await t.fetcher.fetch([{ name: 'stone', count: 10 }], cancelled)

    expect(t.calls).toEqual([])
  })

  it('stops when a step is cancelled', async () => {
    const world = new ConstructionWorld()
    const calls: string[] = []
    const fetcher = new StorageMaterialFetcher({
      inventory: world,
      withdrawer: {
        run: () => {
          calls.push('withdraw')
          return Promise.resolve(err({ reason: 'aborted', message: 'Cancelled.' }))
        },
      },
      scanner: { run: () => Promise.resolve(ok({} as never)) },
    })

    await fetcher.fetch([{ name: 'stone', count: 1 }], context)

    expect(calls).toEqual(['withdraw'])
  })
})
