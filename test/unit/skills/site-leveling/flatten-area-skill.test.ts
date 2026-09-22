import { describe, expect, it } from '@jest/globals'
import type { ItemCount } from '../../../../src/core/recipes.port.js'
import type { SkillContext } from '../../../../src/core/skill.types.js'
import type { MaterialFetcher } from '../../../../src/skills/building/material-fetcher.js'
import { HazardRule } from '../../../../src/skills/construction/hazard-rule.js'
import { PlanExecutor } from '../../../../src/skills/construction/plan-executor.js'
import { SiteSafety } from '../../../../src/skills/construction/site-safety.js'
import { StandingSpotChooser } from '../../../../src/skills/construction/standing-spot.js'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import {
  FlattenAreaSkill,
  type FlattenAreaInput,
} from '../../../../src/skills/site-leveling/flatten-area-skill.js'
import { MarkerFinder } from '../../../../src/skills/site-leveling/marker-finder.js'
import { ConstructionWorld } from '../../../fakes/construction-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeEntityScanner } from '../../../fakes/fake-ports.js'
import { AutoScheduler, FakeDroppedItems, skillContext } from '../../../fakes/gathering-fakes.js'

class FakeFetcher implements MaterialFetcher {
  readonly asked: (readonly ItemCount[])[] = []
  constructor(private readonly onFetch: (world: ConstructionWorld) => void) {}
  private world: ConstructionWorld | undefined
  attach(world: ConstructionWorld): void {
    this.world = world
  }
  fetch(missing: readonly ItemCount[], _context: SkillContext): Promise<void> {
    this.asked.push(missing)
    if (this.world !== undefined) this.onFetch(this.world)
    return Promise.resolve()
  }
}

/** groundY = 60: flat dirt at y <= 60, open air above, everywhere, unless a test overrides a cell. */
function setup(fetcher?: FakeFetcher) {
  const world = new ConstructionWorld(60)
  fetcher?.attach(world)
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
  const entities = new FakeEntityScanner()
  const skill = new FlattenAreaSkill({
    blocks: world,
    entities,
    vitals: world,
    inventory: world,
    executor,
    markers: new MarkerFinder(world),
    ...(fetcher === undefined ? {} : { fetcher }),
  })
  return { world, entities, skill }
}

/** Player standing at (0, 61, 0): "here" resolves to y = 60, matching the flat ground. */
function standPlayer(
  entities: FakeEntityScanner,
  overrides: Partial<{ x: number; y: number; z: number; yaw: number }> = {},
) {
  entities.players.set('owner', {
    name: 'Owner',
    online: true,
    position: { x: overrides.x ?? 0, y: overrides.y ?? 61, z: overrides.z ?? 0 },
    distance: 0,
    yaw: overrides.yaw ?? 0,
  })
}

const request = (patch: Partial<FlattenAreaInput> = {}): FlattenAreaInput => ({
  player: 'owner',
  width: 1,
  length: 1,
  level: 'here',
  clearHeight: 6,
  margin: 0,
  clearTrees: true,
  maxFillDepth: 6,
  clearStructures: false,
  fetchFromStorage: false,
  ...patch,
})

describe('FlattenAreaSkill: run', () => {
  it('cuts a mound down to the level', async () => {
    const s = setup()
    standPlayer(s.entities)
    s.world.setBlock({ x: 0, y: 61, z: 0 }, 'stone')

    const result = await s.skill.run(request(), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { level: 60, cut: 1, cleared: 0, filled: 0, blockedCells: [], tooDeep: [] },
    })
    expect(s.world.nameAt({ x: 0, y: 61, z: 0 })).toBe('air')
  })

  it('fills a hole with dirt when nothing was cut', async () => {
    const s = setup()
    standPlayer(s.entities)
    s.world.setBlock({ x: 0, y: 60, z: 0 }, 'air') // a one-block-deep hole at the player's own column
    s.world.give('dirt', 5) // carried already; nothing here would cut any

    const result = await s.skill.run(request(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { filled: 1, fillBlock: 'dirt' } })
    expect(s.world.nameAt({ x: 0, y: 60, z: 0 })).toBe('dirt')
  })

  it('fills a hole with what cutting a mound elsewhere in the plot produced', async () => {
    const s = setup()
    standPlayer(s.entities)
    // A 1x3 plot facing south (+z): a sand mound at z=0, a hole at z=2.
    s.world.setBlock({ x: 0, y: 61, z: 0 }, 'sand')
    s.world.setBlock({ x: 0, y: 60, z: 2 }, 'air')

    const result = await s.skill.run(
      request({ length: 3, direction: 'south' }),
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { cut: 1, filled: 1, fillBlock: 'sand' } })
    expect(s.world.nameAt({ x: 0, y: 60, z: 2 })).toBe('sand')
  })

  it('uses an explicit fillBlock over whatever cutting produced', async () => {
    const s = setup()
    standPlayer(s.entities)
    // Cutting turns up gravel, but the request asks for sand instead (carried separately).
    s.world.setBlock({ x: 0, y: 61, z: 0 }, 'gravel')
    s.world.setBlock({ x: 0, y: 60, z: 2 }, 'air')
    s.world.give('sand', 5)

    const result = await s.skill.run(
      request({ length: 3, direction: 'south', fillBlock: 'sand' }),
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { fillBlock: 'sand' } })
    expect(s.world.nameAt({ x: 0, y: 60, z: 2 })).toBe('sand')
  })

  it('places surfaceBlock only on the top of a filled column', async () => {
    const s = setup()
    standPlayer(s.entities)
    s.world.setBlock({ x: 0, y: 59, z: 0 }, 'air')
    s.world.setBlock({ x: 0, y: 60, z: 0 }, 'air') // two-deep hole
    s.world.give('dirt', 5)
    s.world.give('stone', 5)

    const result = await s.skill.run(
      request({ fillBlock: 'dirt', surfaceBlock: 'stone' }),
      skillContext().context,
    )

    expect(result.ok).toBe(true)
    expect(s.world.nameAt({ x: 0, y: 59, z: 0 })).toBe('dirt')
    expect(s.world.nameAt({ x: 0, y: 60, z: 0 })).toBe('stone')
  })

  it('leaves a hole deeper than maxFillDepth alone, reported as too deep', async () => {
    const s = setup()
    standPlayer(s.entities)
    for (let y = 55; y <= 60; y += 1) s.world.setBlock({ x: 0, y, z: 0 }, 'air') // 6 deep

    const result = await s.skill.run(request({ maxFillDepth: 3 }), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { filled: 0, tooDeep: [{ x: 0, y: 54, z: 0 }] },
    })
  })

  it('leaves a player-made block above the level alone, reported as blocked_cells', async () => {
    const s = setup()
    standPlayer(s.entities)
    s.world.setBlock({ x: 0, y: 61, z: 0 }, 'oak_fence')

    const result = await s.skill.run(request(), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { cut: 0, cleared: 0, blockedCells: [{ x: 0, y: 61, z: 0 }] },
    })
    expect(s.world.nameAt({ x: 0, y: 61, z: 0 })).toBe('oak_fence') // untouched
  })

  it('clears a player-made block too when clearStructures is true', async () => {
    const s = setup()
    standPlayer(s.entities)
    s.world.setBlock({ x: 0, y: 61, z: 0 }, 'oak_fence')

    const result = await s.skill.run(request({ clearStructures: true }), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { blockedCells: [] } })
    expect(s.world.nameAt({ x: 0, y: 61, z: 0 })).toBe('air')
  })

  it('leaves a log standing when clearTrees is off', async () => {
    const s = setup()
    standPlayer(s.entities)
    s.world.setBlock({ x: 0, y: 61, z: 0 }, 'oak_log')

    const result = await s.skill.run(request({ clearTrees: false }), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { blockedCells: [{ x: 0, y: 61, z: 0 }] } })
    expect(s.world.nameAt({ x: 0, y: 61, z: 0 })).toBe('oak_log')
  })

  it('uses an explicit y level instead of "here"', async () => {
    const s = setup()
    standPlayer(s.entities)
    // The ground is flat at y = 60 ("here"); level: y: 58 means two layers (59, 60) need cutting.

    const result = await s.skill.run(request({ level: 'y', y: 58 }), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { level: 58, cut: 2 } })
  })

  it('refuses level: "y" with no y given', async () => {
    const s = setup()
    standPlayer(s.entities)

    const result = await s.skill.run(request({ level: 'y' }), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'missing_level' } })
  })

  it('refuses level: "auto": run always needs an explicit level', async () => {
    const s = setup()
    standPlayer(s.entities)

    const result = await s.skill.run(request({ level: 'auto' }), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'ambiguous_level' } })
  })

  it('refuses a plot bigger than the size limit', async () => {
    const s = setup()
    standPlayer(s.entities)

    const result = await s.skill.run(request({ width: 64, length: 65 }), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'too_large' } })
  })

  it('reports player_not_online for a player who is not online', async () => {
    const s = setup()

    const result = await s.skill.run(request(), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'player_not_online' } })
  })

  it('reports player_not_visible for an online player out of view', async () => {
    const s = setup()
    s.entities.players.set('owner', {
      name: 'Owner',
      online: true,
      position: undefined,
      distance: undefined,
      yaw: undefined,
    })

    const result = await s.skill.run(request(), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'player_not_visible' } })
  })

  it('reports markers_not_found when no size and no markers are given', async () => {
    const s = setup()
    standPlayer(s.entities)

    const result = await s.skill.run(
      request({ width: undefined, length: undefined }),
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'markers_not_found' } })
  })

  it('sizes the plot from two corner markers when no width/length is given', async () => {
    const s = setup()
    standPlayer(s.entities)
    // Two marker stacks at x = 0 and x = 4, standing on stone (not more dirt, so the stack's own foot is
    // recognisable and not mistaken for a natural dirt column going deeper).
    for (const x of [0, 4]) {
      s.world.setBlock({ x, y: 60, z: 0 }, 'stone')
      s.world.setBlock({ x, y: 61, z: 0 }, 'dirt')
      s.world.setBlock({ x, y: 62, z: 0 }, 'dirt')
    }
    s.world.findBlocks = ({ names, count }) =>
      [
        { name: 'dirt', position: { x: 0, y: 61, z: 0 }, distance: 0 },
        { name: 'dirt', position: { x: 4, y: 61, z: 0 }, distance: 4 },
      ]
        .filter((b) => names.includes(b.name))
        .slice(0, count)

    const result = await s.skill.run(
      request({ width: undefined, length: undefined }),
      skillContext().context,
    )

    // The markers themselves (2 cells each, both natural dirt, above level 60) are cut away with the rest of the
    // plot: "the markers are part of the instruction, not obstacles."
    expect(result).toMatchObject({ ok: true, value: { cut: 4 } })
  })

  it('fetches missing fill material from storage when the cut did not produce enough', async () => {
    const fetcher = new FakeFetcher((world) => {
      world.give('dirt', 5)
    })
    const s = setup(fetcher)
    standPlayer(s.entities)
    s.world.setBlock({ x: 0, y: 60, z: 0 }, 'air') // a hole; nothing was cut to fill it

    const result = await s.skill.run(request({ fetchFromStorage: true }), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { filled: 1, fillBlock: 'dirt' } })
    expect(fetcher.asked).toEqual([[{ name: 'dirt', count: 1 }]])
  })

  it('reports the fill failure, noting the cut already finished, when the fill step itself fails', async () => {
    const s = setup()
    standPlayer(s.entities)
    // A 1x3 plot facing south: a stone mound at z=0 (cuts fine, but stone is not a fill candidate) and a hole,
    // in its own unobstructed column, at z=2. Nothing else supplies dirt, and there is no fetcher.
    s.world.setBlock({ x: 0, y: 61, z: 0 }, 'stone')
    s.world.setBlock({ x: 0, y: 60, z: 2 }, 'air')

    const result = await s.skill.run(
      request({ length: 3, direction: 'south' }),
      skillContext().context,
    )

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'missing_materials', detail: { cutDone: true } },
    })
    expect(s.world.nameAt({ x: 0, y: 61, z: 0 })).toBe('air') // the cut itself did happen
  })

  it('resolves level: "markers" from separate markers even when the area comes from width/length', async () => {
    const s = setup()
    standPlayer(s.entities)
    // Both markers stand on stone, not more dirt, so each stack's own foot is recognisable; marker B is well
    // clear of marker A, so the two never interfere with each other's isolation check.
    s.world.setBlock({ x: 5, y: 60, z: 0 }, 'stone')
    s.world.setBlock({ x: 5, y: 61, z: 0 }, 'dirt')
    s.world.setBlock({ x: 5, y: 62, z: 0 }, 'dirt')
    s.world.setBlock({ x: 20, y: 64, z: 0 }, 'stone')
    s.world.setBlock({ x: 20, y: 65, z: 0 }, 'dirt')
    s.world.setBlock({ x: 20, y: 66, z: 0 }, 'dirt')
    s.world.give('dirt', 5) // the player's own column is 1 short of the raised level; nothing here cuts any
    s.world.findBlocks = ({ names, count }) =>
      [
        { name: 'dirt', position: { x: 5, y: 61, z: 0 }, distance: 0 },
        { name: 'dirt', position: { x: 20, y: 65, z: 0 }, distance: 15 },
      ]
        .filter((b) => names.includes(b.name))
        .slice(0, count)

    const result = await s.skill.run(request({ level: 'markers' }), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { level: 61 } }) // the lower of the two marker bases
  })
})

describe('FlattenAreaSkill: preview', () => {
  it('changes nothing and reports the same counts run would produce', () => {
    const s = setup()
    standPlayer(s.entities)
    s.world.setBlock({ x: 0, y: 61, z: 0 }, 'stone')

    const preview = s.skill.preview(request())

    expect(preview).toMatchObject({ ok: true, value: { toCut: 1, toClear: 0 } })
    expect(s.world.nameAt({ x: 0, y: 61, z: 0 })).toBe('stone') // untouched
  })

  it('suggests a level and compares it to the cost at "here" when level is "auto"', () => {
    const s = setup()
    standPlayer(s.entities)
    // A mound at x=0 (needs cutting from "here"); the median across a wider plot is lower ground.
    s.world.setBlock({ x: 0, y: 61, z: 0 }, 'stone')

    const preview = s.skill.preview(request({ level: 'auto', width: 3, length: 1 }))

    expect(preview.ok).toBe(true)
    if (preview.ok) expect(preview.value.suggestion).toBeDefined()
  })
})
