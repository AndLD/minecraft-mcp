import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { HazardRule } from '../../../../src/skills/construction/hazard-rule.js'
import {
  PlanExecutor,
  type PlanOptions,
} from '../../../../src/skills/construction/plan-executor.js'
import { PlanVerifier } from '../../../../src/skills/construction/plan-verifier.js'
import { SiteSafety } from '../../../../src/skills/construction/site-safety.js'
import { isSpecialBlock } from '../../../../src/skills/construction/special-blocks.js'
import { StandingSpotChooser } from '../../../../src/skills/construction/standing-spot.js'
import type { WorkPlan, WorkStep } from '../../../../src/skills/construction/work-plan.types.js'
import { QuarryProvider } from '../../../../src/skills/excavation/providers/dig-down.js'
import { DigToProvider } from '../../../../src/skills/excavation/providers/dig-to.js'
import { TunnelProvider } from '../../../../src/skills/excavation/providers/tunnels.js'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import { ConstructionWorld } from '../../../fakes/construction-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { AutoScheduler, FakeDroppedItems, skillContext } from '../../../fakes/gathering-fakes.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })
const options: PlanOptions = { clearObstacles: true }
const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`

/** Solid rock up to y = 80, with an open pocket at (0, 50..51, 0) where the bot stands. */
function mine() {
  const world = new ConstructionWorld(80)
  world.setBlock(at(0, 50, 0), 'air')
  world.setBlock(at(0, 51, 0), 'air')
  world.bot = at(0.5, 50, 0.5)
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
  return { world, executor }
}

const verified = (plan: WorkPlan, patch: Partial<WorkPlan> = {}): WorkPlan => ({
  ...plan,
  verify: true,
  ...patch,
})
const tunnel = (params: object, origin = at(0, 50, 0)): WorkPlan => {
  const p = new TunnelProvider()
  return p.generate(p.params.parse({ direction: 'north', torch_spacing: 0, ...params }), {
    origin,
    minY: -64,
  })
}
const isOpen = (world: ConstructionWorld, p: Position): boolean => world.nameAt(p) === 'air'

describe('special blocks', () => {
  it.each([
    'chest',
    'crafting_table',
    'torch',
    'wall_torch',
    'ladder',
    'oak_sign',
    'oak_door',
    'white_bed',
    'barrel',
  ])('%s is special', (name) => {
    expect(isSpecialBlock(name)).toBe(true)
  })
  it.each(['cobblestone', 'dirt', 'gravel', 'stone', 'iron_ore'])('%s is not special', (name) => {
    expect(isSpecialBlock(name)).toBe(false)
  })
})

describe('PlanVerifier', () => {
  const plan: WorkPlan = {
    name: 'p',
    steps: [0, 1, 2, 3, 4].map((x): WorkStep => ({ kind: 'break', at: at(x, 50, 0) })),
  }
  const verifier = (cells: Record<number, string>) => {
    const w = new ConstructionWorld(80)
    for (let x = 0; x <= 4; x += 1) w.setBlock(at(x, 50, 0), cells[x] ?? 'air')
    return new PlanVerifier(w)
  }

  it('finds nothing when the shape is dug out', () => {
    expect(verifier({}).scan(plan, () => false, new Set())).toEqual({
      checked: 5,
      strays: [],
      kept: 0,
      fluids: [],
    })
  })

  it('reports a stray cobblestone or dirt, but never a chest or a torch', () => {
    const found = verifier({ 1: 'cobblestone', 2: 'chest', 3: 'torch', 4: 'dirt' }).scan(
      plan,
      () => false,
      new Set(),
    )

    expect(found.strays).toEqual([at(1, 50, 0), at(4, 50, 0)])
    expect(found.kept).toBe(2)
  })

  it('leaves water and lava to the report, and cells of an ended chain unchecked', () => {
    const found = verifier({ 0: 'water', 1: 'stone', 2: 'lava' }).scan(
      plan,
      (step) => step.at.x === 1,
      new Set(),
    )

    expect(found.fluids).toEqual([at(0, 50, 0), at(2, 50, 0)])
    expect(found.strays).toEqual([])
    expect(found.checked).toBe(4)
  })

  it('counts a block the plan places itself as in place', () => {
    const found = verifier({ 1: 'oak_door' }).scan(plan, () => false, new Set(['oak_door']))

    expect(found.strays).toEqual([])
  })

  it('lists the open cells beside the shape that a probe reaches, once each, never the shape itself', () => {
    const w = new ConstructionWorld(80)
    const probing: WorkPlan = {
      name: 'p',
      steps: [
        {
          kind: 'break',
          at: at(0, 50, 0),
          probe: [
            { x: 0, y: 1, z: 0 },
            { x: 1, y: 0, z: 0 },
          ],
        },
        { kind: 'break', at: at(1, 50, 0), probe: [{ x: 0, y: 1, z: 0 }] },
      ],
    }
    for (const p of [at(0, 50, 0), at(1, 50, 0), at(0, 51, 0), at(1, 51, 0)]) w.setBlock(p, 'air')

    const openings = new PlanVerifier(w).openings(probing, () => false)

    expect(openings).toEqual([at(0, 51, 0), at(1, 51, 0)])
  })
})

describe('a quarry over a cavern that cuts through its floor', () => {
  const quarry = () => {
    const p = new QuarryProvider()
    const plan = p.generate(
      p.params.parse({ width: 3, length: 3, to_y: 49, exit: 'none', seal_caves: true }),
      { origin: at(0, 51, 0), minY: -64 },
    )
    if ('error' in plan) throw new Error(plan.error)
    return plan
  }
  const cavern = (s: ReturnType<typeof mine>) => {
    // The bottom layer (y 49) and a ring around it are open: one cavern.
    for (let x = -2; x <= 4; x += 1)
      for (let z = -2; z <= 4; z += 1) s.world.setBlock(at(x, 49, z), 'air')
  }

  it('leaves no block inside the dug volume, and says it checked', async () => {
    const s = mine()
    s.world.give('cobblestone', 60)
    cavern(s)

    const result = await s.executor.run(verified(quarry()), options, skillContext().context)

    expect(result).toMatchObject({ ok: true })
    for (let x = 0; x <= 2; x += 1)
      for (let z = 0; z <= 2; z += 1)
        for (const y of [51, 50, 49]) expect(isOpen(s.world, at(x, y, z))).toBe(true)
    if (result.ok) expect(result.value.shapeCheck).toMatchObject({ checked: 27, kept: 0 })
  })

  it('seals the cavern beside the bottom layer, outside the volume', async () => {
    const s = mine()
    s.world.give('cobblestone', 60)
    cavern(s)

    const result = await s.executor.run(verified(quarry()), options, skillContext().context)

    expect(result).toMatchObject({ ok: true })
    expect(s.world.nameAt(at(-1, 49, 1))).toBe('cobblestone')
    expect(s.world.nameAt(at(3, 49, 1))).toBe('cobblestone')
    if (result.ok) expect(result.value.shapeCheck?.sealed).toBeGreaterThan(0)
  })

  it('reports, but cannot close, the openings with nothing to seal with', async () => {
    const s = mine()
    cavern(s)
    // Neither the seal block nor its fallback is carried (dug dirt would count as the fallback).
    const plan = verified(quarry(), { seal: { block: 'cobblestone', fallback: 'emerald_block' } })

    const result = await s.executor.run(plan, options, skillContext().context)

    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.value.shapeCheck?.unsealed).toBeGreaterThan(0)
  })
})

describe('verification at the end of a dig', () => {
  /** Puts `block` into the tunnel's first cell right after the cell at z = -3 is dug (something settling). */
  const dropAfterDig = (s: ReturnType<typeof mine>, block: string): void => {
    const original = s.world.dig.bind(s.world)
    s.world.dig = async (position, signal) => {
      const dug = await original(position, signal)
      if (position.z === -3 && position.y === 50) s.world.setBlock(at(0, 50, -1), block)
      return dug
    }
  }

  it('clears a stray block that lands in a dug cell', async () => {
    const s = mine()
    dropAfterDig(s, 'gravel')

    const result = await s.executor.run(
      verified(tunnel({ length: 4 })),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true })
    expect(isOpen(s.world, at(0, 50, -1))).toBe(true)
  })

  it('leaves a torch standing in a dug cell, and counts it as kept', async () => {
    const s = mine()
    dropAfterDig(s, 'torch')

    const result = await s.executor.run(
      verified(tunnel({ length: 4 })),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { shapeCheck: { kept: 1 } } })
    expect(s.world.nameAt(at(0, 50, -1))).toBe('torch')
  })

  it('never breaks a chest a player put in a dug cell: the chain ends there and the chest stays', async () => {
    const s = mine()
    dropAfterDig(s, 'chest')

    const result = await s.executor.run(
      verified(tunnel({ length: 4 })),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { ended: [{ reason: 'player_block' }] } })
    expect(s.world.nameAt(at(0, 50, -1))).toBe('chest')
  })

  it('reports a stray block that will not clear as an incomplete run, not a success', async () => {
    const s = mine()
    dropAfterDig(s, 'gravel')
    const before = s.world.dig.bind(s.world)
    s.world.dig = (position, signal) =>
      position.z === -1 && position.y === 50 && s.world.nameAt(position) === 'gravel'
        ? Promise.resolve({
            ok: false as const,
            error: { reason: 'failed' as const, message: 'no' },
          })
        : before(position, signal)

    const result = await s.executor.run(
      verified(tunnel({ length: 4 })),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'incomplete' } })
  })

  it('does not check plans that did not ask for it', async () => {
    const s = mine()

    const result = await s.executor.run(tunnel({ length: 3 }), options, skillContext().context)

    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.value.shapeCheck).toBeUndefined()
  })

  it('leaves cells of a chain a hazard ended out of the check', async () => {
    const s = mine()
    s.world.setBlock(at(1, 50, -3), 'lava')

    const result = await s.executor.run(
      verified(tunnel({ length: 6 })),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { ended: [{ reason: 'hit_lava' }] } })
  })
})

describe('sand and gravel above the dig', () => {
  const gravelColumn = (s: ReturnType<typeof mine>, height: number, z = -4) => {
    for (let i = 0; i < height; i += 1) s.world.setBlock(at(0, 52 + i, z), 'gravel')
  }

  it('stops by default and names every cell of the column that blocks it', async () => {
    const s = mine()
    gravelColumn(s, 3)

    const result = await s.executor.run(tunnel({ length: 8 }), options, skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: {
        ended: [
          {
            reason: 'falling_blocks',
            at: at(0, 52, -4),
            cells: [at(0, 52, -4), at(0, 53, -4), at(0, 54, -4)],
          },
        ],
      },
    })
  })

  it('digs the column from the top down with fallingBlocks: clear, then carries on', async () => {
    const s = mine()
    gravelColumn(s, 3)

    const result = await s.executor.run(
      { ...tunnel({ length: 8 }), fallingBlocks: 'clear' },
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { ended: [] } })
    for (const y of [52, 53, 54]) expect(s.world.nameAt(at(0, y, -4))).toBe('air')
    expect(isOpen(s.world, at(0, 50, -7))).toBe(true)
    const gravelDigs = s.world.log.filter((line) => /^dig 0,5[234],-4$/.test(line))
    expect(gravelDigs).toEqual(['dig 0,54,-4', 'dig 0,53,-4', 'dig 0,52,-4'])
  })

  it('still ends at water beside the column, whatever the mode', async () => {
    const s = mine()
    gravelColumn(s, 2)
    s.world.setBlock(at(1, 53, -4), 'water')

    const result = await s.executor.run(
      { ...tunnel({ length: 8 }), fallingBlocks: 'clear' },
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { ended: [{ reason: 'hit_water' }] } })
    expect(s.world.nameAt(at(0, 52, -4))).toBe('gravel')
  })

  it('gives up on a column taller than it will dig, and names it', async () => {
    const s = mine()
    for (let i = 0; i < 30; i += 1) s.world.setBlock(at(0, 52 + i, -4), 'gravel')

    const result = await s.executor.run(
      { ...tunnel({ length: 8 }), fallingBlocks: 'clear' },
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { ended: [{ reason: 'falling_blocks' }] } })
  })

  it('digs gravel over a cell the plan itself digs before that cell, in either mode', async () => {
    const s = mine()
    // A two-high tunnel: the gravel sits in the tunnel's own upper cell, above the lower one.
    s.world.setBlock(at(0, 51, -4), 'gravel')

    const result = await s.executor.run(tunnel({ length: 8 }), options, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { ended: [] } })
    expect(isOpen(s.world, at(0, 50, -4))).toBe(true)
    expect(isOpen(s.world, at(0, 51, -4))).toBe(true)
  })
})

describe('the cave check inside a dug volume', () => {
  it('does not count an open cell of a whole-volume plan as a cave', () => {
    const world = new ConstructionWorld(80)
    world.setBlock(at(1, 50, 0), 'air')
    const rule = new HazardRule(world)
    const step: WorkStep = { kind: 'break', at: at(0, 50, 0), probe: [{ x: 1, y: 0, z: 0 }] }
    const plan: WorkPlan = {
      name: 'p',
      steps: [step, { kind: 'break', at: at(1, 50, 0) }],
      cavityCheck: true,
      ownVolume: true,
    }
    const state = {
      order: new Map([
        [key(at(0, 50, 0)), 0],
        [key(at(1, 50, 0)), 1],
      ]),
      index: 0,
      dug: new Set<string>(),
      volume: new Set([key(at(0, 50, 0)), key(at(1, 50, 0))]),
    }

    expect(rule.check(step, plan, state)).toBeUndefined()
    expect(rule.check(step, { ...plan, ownVolume: false }, state)).toMatchObject({
      reason: 'cave_breakthrough',
    })
  })
})

describe('DigToProvider', () => {
  const provider = new DigToProvider()
  const generate = (target: Position, origin = at(0, 50, 0), extra: object = {}) =>
    provider.generate(provider.params.parse({ target, torch_spacing: 0, ...extra }), {
      origin,
      minY: -64,
    })
  const planOf = (target: Position, origin = at(0, 50, 0), extra: object = {}): WorkPlan => {
    const plan = generate(target, origin, extra)
    if ('error' in plan) throw new Error(plan.error)
    return plan
  }

  it('digs a two-high route, then the target, in order', () => {
    const plan = planOf(at(5, 50, 0))

    const breaks = plan.steps.filter((s) => s.kind === 'break').map((s) => key(s.at))
    expect(breaks.slice(-1)).toEqual(['5,50,0'])
    expect(breaks).toContain('4,50,0')
    expect(breaks).toContain('4,51,0')
    expect(breaks).not.toContain('0,50,0') // where the bot stands
    expect(plan.hazards).toBe('end_branch')
    expect(plan.cavityCheck).toBe(true)
  })

  it('goes along x, then z', () => {
    const plan = planOf(at(3, 50, 3))

    const columns = new Set(
      plan.steps
        .filter((s) => s.kind === 'break')
        .map((s) => `${String(s.at.x)},${String(s.at.z)}`),
    )
    expect(columns).toEqual(new Set(['1,0', '2,0', '3,0', '3,1', '3,2', '3,3']))
  })

  it('steps down one block per block sideways, with headroom at every change', () => {
    const plan = planOf(at(4, 47, 0))

    const heights = plan.steps.filter((s) => s.kind === 'break' && s.at.x === 3).map((s) => s.at.y)
    expect(Math.min(...heights)).toBe(47)
    expect(Math.max(...heights)).toBeGreaterThanOrEqual(49)
    expect(plan.steps.filter((s) => s.kind === 'break').at(-1)?.at).toEqual(at(4, 47, 0))
  })

  it('makes every cell need the one before it, so a chain that ends leaves the rest', () => {
    const plan = planOf(at(4, 50, 0))

    const withoutNeeds = plan.steps.filter((s) => s.kind === 'break' && s.needs === undefined)
    expect(withoutNeeds.length).toBeLessThanOrEqual(1)
  })

  it('refuses a target too steep for the distance, and says what to do', () => {
    expect(generate(at(2, 40, 0))).toMatchObject({ error: expect.stringContaining('shaft') })
  })

  it('refuses a target at the start, and one below the lowest layer', () => {
    expect(generate(at(0, 50, 0))).toMatchObject({
      error: expect.stringContaining('nothing to dig'),
    })
    expect(generate(at(9, -70, 0), at(0, -63, 0))).toMatchObject({
      error: expect.stringContaining('lowest layer'),
    })
  })

  it('places torches along the route when asked', () => {
    const plan = planOf(at(12, 50, 0), at(0, 50, 0), { torch_spacing: 4 })

    expect(plan.steps.filter((s) => s.kind === 'light').length).toBeGreaterThanOrEqual(2)
  })

  it('takes seal options like a tunnel', () => {
    const sealed = planOf(at(5, 50, 0))
    const open = planOf(at(5, 50, 0), at(0, 50, 0), { seal_caves: false })

    expect(sealed.seal).toBeDefined()
    expect(open.seal).toBeUndefined()
  })

  it.each([at(6, 50, 0), at(5, 47, 2)])(
    'digs its way to the target in a fake mine (%j)',
    async (target) => {
      const s = mine()

      const result = await s.executor.run(
        { ...planOf(target), verify: true },
        options,
        skillContext().context,
      )

      expect(result).toMatchObject({ ok: true, value: { ended: [] } })
      expect(isOpen(s.world, target)).toBe(true)
    },
  )

  it('ends at lava beside the route, like a tunnel', async () => {
    const s = mine()
    s.world.setBlock(at(3, 50, 1), 'lava')

    const result = await s.executor.run(planOf(at(6, 50, 0)), options, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { ended: [{ reason: 'hit_lava' }] } })
    expect(isOpen(s.world, at(6, 50, 0))).toBe(false)
  })
})
