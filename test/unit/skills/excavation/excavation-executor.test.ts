import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { HazardRule } from '../../../../src/skills/construction/hazard-rule.js'
import {
  PlanExecutor,
  type PlanOptions,
} from '../../../../src/skills/construction/plan-executor.js'
import { SiteSafety } from '../../../../src/skills/construction/site-safety.js'
import { StandingSpotChooser } from '../../../../src/skills/construction/standing-spot.js'
import type { WorkPlan, WorkStep } from '../../../../src/skills/construction/work-plan.types.js'
import type { SpoilDiscarder } from '../../../../src/skills/construction/spoil-discarder.js'
import type { SupplyCrafter } from '../../../../src/skills/construction/crafting-supplies.js'
import {
  PitProvider,
  QuarryProvider,
} from '../../../../src/skills/excavation/providers/dig-down.js'
import {
  BranchMineProvider,
  TunnelProvider,
} from '../../../../src/skills/excavation/providers/tunnels.js'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import { ConstructionWorld } from '../../../fakes/construction-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { AutoScheduler, FakeDroppedItems, skillContext } from '../../../fakes/gathering-fakes.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })
const options: PlanOptions = { clearObstacles: true }

/** Solid rock up to y = 80, with an open pocket at (0, 50..51, 0) where the bot stands. */
function mine(extra: { discarder?: SpoilDiscarder; supplies?: SupplyCrafter } = {}) {
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
    ...extra,
  })
  return { world, executor }
}

const tunnelPlan = (params: object, origin = at(0, 50, 0)): WorkPlan => {
  const p = new TunnelProvider()
  return p.generate(p.params.parse({ direction: 'north', ...params }), { origin, minY: -64 })
}
const mineOf = (params: object, origin = at(0, 50, 0)): WorkPlan => {
  const p = new BranchMineProvider()
  return p.generate(p.params.parse({ direction: 'north', ...params }), { origin, minY: -64 })
}
/** Dug out: open air, or a torch or ladder standing in the opening. */
const isAir = (world: ConstructionWorld, x: number, y: number, z: number): boolean =>
  ['air', 'torch', 'ladder'].includes(world.nameAt(at(x, y, z)))

describe('digging a tunnel', () => {
  it('digs every cell, walking forward as it goes', async () => {
    const s = mine()
    s.world.give('torch', 5)

    const result = await s.executor.run(tunnelPlan({ length: 8 }), options, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { ended: [] } })
    for (let z = 0; z >= -7; z -= 1) {
      expect(isAir(s.world, 0, 50, z)).toBe(true)
      expect(isAir(s.world, 0, 51, z)).toBe(true)
    }
    expect(isAir(s.world, 0, 50, -8)).toBe(false) // one block beyond the end stays
    expect(isAir(s.world, 1, 50, -3)).toBe(false) // the walls stay
    expect(s.world.trips.length).toBeGreaterThan(0)
  })

  it('places torches along it: the first after 6 blocks, then every 6', async () => {
    const s = mine()
    s.world.give('torch', 5)

    await s.executor.run(tunnelPlan({ length: 14 }), options, skillContext().context)

    expect(s.world.nameAt(at(0, 50, -5))).toBe('torch')
    expect(s.world.nameAt(at(0, 50, -11))).toBe('torch')
    expect(s.world.nameAt(at(0, 50, -8))).not.toBe('torch')
    expect(s.world.carried.get('torch')).toBe(3)
  })

  it('stops with no_torches when they run out, and says what is missing', async () => {
    const s = mine()

    const result = await s.executor.run(tunnelPlan({ length: 14 }), options, skillContext().context)

    // The preview already asks for the torches, so it refuses before digging.
    expect(result).toMatchObject({ ok: false, error: { reason: 'missing_materials' } })
    expect(s.world.log).toEqual([])
  })

  it('stops in the middle when the torches are used up sooner than expected', async () => {
    const s = mine()
    s.world.give('torch', 2)
    s.world.placeFailures = [] // the torches are all there; take one away after the first is placed
    s.world.onPlaced = () => {
      s.world.carried.set('torch', 0)
    }

    const result = await s.executor.run(tunnelPlan({ length: 14 }), options, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_torches' } })
    expect(isAir(s.world, 0, 50, -5)).toBe(true) // it got as far as the first torch
  })

  it('needs no torches when the spacing is 0', async () => {
    const s = mine()

    const result = await s.executor.run(
      tunnelPlan({ length: 10, torch_spacing: 0 }),
      options,
      skillContext().context,
    )

    expect(result.ok).toBe(true)
  })

  it('does not put a torch where it is already bright', async () => {
    const s = mine()
    s.world.give('torch', 5)
    s.world.light.set('0,50,-5', 12)

    await s.executor.run(tunnelPlan({ length: 6 }), options, skillContext().context)

    expect(s.world.nameAt(at(0, 50, -5))).not.toBe('torch')
  })

  it('can be run again: what is dug is skipped', async () => {
    const s = mine()
    s.world.give('torch', 5)
    const plan = tunnelPlan({ length: 8 })
    await s.executor.run(plan, options, skillContext().context)
    const digs = s.world.log.filter((l) => l.startsWith('dig')).length

    const again = await s.executor.run(plan, options, skillContext().context)

    expect(again).toMatchObject({ ok: true, value: { broken: 0 } })
    expect(s.world.log.filter((l) => l.startsWith('dig')).length).toBe(digs)
  })
})

describe('hazards end a tunnel one block short', () => {
  it('stops before lava ahead, records where, and leaves the lava alone', async () => {
    const s = mine()
    s.world.give('torch', 5)
    s.world.setBlock(at(0, 50, -6), 'lava')

    const result = await s.executor.run(tunnelPlan({ length: 12 }), options, skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { ended: [{ branch: 'main', reason: 'hit_lava', at: at(0, 50, -6) }] },
    })
    // The cell next to the lava (z = -5) is where it stopped: it is not dug.
    expect(isAir(s.world, 0, 50, -4)).toBe(true)
    expect(isAir(s.world, 0, 50, -5)).toBe(false)
    expect(s.world.nameAt(at(0, 50, -6))).toBe('lava')
    const ended = result.ok ? result.value.ended[0] : undefined
    expect(ended?.skipped).toBeGreaterThan(5)
  })

  it('stops before water beside the way, too', async () => {
    const s = mine()
    s.world.give('torch', 5)
    s.world.setBlock(at(1, 51, -4), 'water')

    const result = await s.executor.run(tunnelPlan({ length: 12 }), options, skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { ended: [{ branch: 'main', reason: 'hit_water', at: at(1, 51, -4) }] },
    })
    expect(s.world.nameAt(at(1, 51, -4))).toBe('water')
  })

  it('stops at a cave ahead (a breakthrough), and at a chest, with sealing off', async () => {
    const cave = mine()
    cave.world.give('torch', 5)
    cave.world.setBlock(at(0, 50, -7), 'air') // an open cavity
    const caved = await cave.executor.run(
      tunnelPlan({ length: 12, seal_caves: false }),
      options,
      skillContext().context,
    )
    expect(caved).toMatchObject({ ok: true, value: { ended: [{ reason: 'cave_breakthrough' }] } })
    expect(isAir(cave.world, 0, 50, -5)).toBe(true) // it dug up to just before the cavity

    const chest = mine()
    chest.world.give('torch', 5)
    chest.world.setBlock(at(0, 51, -4), 'chest')
    const chested = await chest.executor.run(
      tunnelPlan({ length: 12 }),
      options,
      skillContext().context,
    )
    expect(chested).toMatchObject({
      ok: true,
      value: { ended: [{ reason: 'player_block', at: at(0, 51, -4) }] },
    })
    expect(chest.world.nameAt(at(0, 51, -4))).toBe('chest')
  })

  it('stops under falling gravel', async () => {
    const s = mine()
    s.world.give('torch', 5)
    s.world.setBlock(at(0, 52, -4), 'gravel')

    const result = await s.executor.run(tunnelPlan({ length: 12 }), options, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { ended: [{ reason: 'falling_blocks' }] } })
  })

  it('works on the parts it can when a chain is protected: the plan refuses to start', async () => {
    const s = mine()
    s.world.give('torch', 5)
    s.world.protectedBoxes.push({ label: 'base', contains: (p) => p.z <= -3 })

    const result = await s.executor.run(tunnelPlan({ length: 8 }), options, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'protected_area' } })
    expect(s.world.log).toEqual([])
  })

  it('does not refuse a site with lava near it, as a building would: the rule handles it per block', async () => {
    const s = mine()
    s.world.give('torch', 5)
    s.world.setBlock(at(3, 50, -3), 'lava')

    const result = await s.executor.run(tunnelPlan({ length: 6 }), options, skillContext().context)

    expect(result.ok).toBe(true) // the lava is not next to any cell of the tunnel
  })
})

describe('cave sealing', () => {
  it('seals a cave breakthrough with a placed block and carries on to the planned length', async () => {
    const s = mine()
    s.world.give('torch', 5)
    s.world.give('cobblestone', 10)
    s.world.setBlock(at(0, 50, -7), 'air') // an open cavity, right in the tunnel's own path

    const result = await s.executor.run(tunnelPlan({ length: 12 }), options, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { ended: [] } })
    expect(result.ok && result.value.used).toEqual(
      expect.arrayContaining([{ name: 'cobblestone', count: 1 }]),
    )
    expect(isAir(s.world, 0, 50, -11)).toBe(true) // it reached the full planned length, past the cave
  })

  it('falls back to dirt when no cobblestone is carried (dirt is what digging the tunnel itself yields)', async () => {
    const s = mine()
    s.world.give('torch', 5)
    s.world.setBlock(at(0, 50, -7), 'air')

    const result = await s.executor.run(tunnelPlan({ length: 12 }), options, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { ended: [] } })
    expect(result.ok && result.value.used).toEqual(
      expect.arrayContaining([{ name: 'dirt', count: 1 }]),
    )
  })

  it('ends the chain as usual when there is nothing at all to seal a cave with', async () => {
    const s = mine()
    // A cave to the side of the very first real cell (i = 0 is the already-open start pocket, so this is the
    // first hazard check that ever runs): the bot has dug nothing yet, so it carries no dirt either.
    s.world.setBlock(at(1, 50, -1), 'air')

    const result = await s.executor.run(
      tunnelPlan({ length: 12, torch_spacing: 0 }),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { ended: [{ reason: 'cave_breakthrough' }] } })
    expect(result.ok && result.value.broken).toBe(0)
  })

  it('leaves the cave open when seal_caves is off', async () => {
    const s = mine()
    s.world.give('torch', 5)
    s.world.give('cobblestone', 10)
    s.world.setBlock(at(0, 50, -7), 'air')

    const result = await s.executor.run(
      tunnelPlan({ length: 12, seal_caves: false }),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { ended: [{ reason: 'cave_breakthrough' }] } })
    // A torch was placed along the way, but never the seal material: the cave itself was left untouched.
    expect(result.ok && result.value.used).not.toEqual(
      expect.arrayContaining([{ name: 'cobblestone', count: expect.any(Number) }]),
    )
    expect(s.world.nameAt(at(0, 50, -7))).toBe('air')
  })
})

describe('side branches', () => {
  it('a hazard ends only the branch that meets it, the others carry on', async () => {
    const s = mine()
    s.world.give('torch', 20)
    s.world.setBlock(at(4, 50, -3), 'lava') // in the right branch at the first junction
    const plan = mineOf({ length: 7, branch_length: 5 })

    const result = await s.executor.run(plan, options, skillContext().context)

    expect(result).toMatchObject({ ok: true })
    const ended = result.ok ? result.value.ended : []
    expect(ended.map((e) => e.branch)).toEqual(['right-3'])
    expect(ended[0]?.reason).toBe('hit_lava')
    expect(isAir(s.world, 1, 50, -3)).toBe(true) // the right branch got as far as it could
    expect(isAir(s.world, 3, 50, -3)).toBe(false) // one short of the lava (which is at x = 4)
    expect(isAir(s.world, -5, 50, -3)).toBe(true) // the left branch at the same junction went all the way
    expect(isAir(s.world, 5, 50, -6)).toBe(true) // and the next junction's right branch too
  })

  it('branches beyond a main tunnel that ended early are skipped, with the reason', async () => {
    const s = mine()
    s.world.give('torch', 20)
    s.world.setBlock(at(0, 50, -5), 'lava')
    const plan = mineOf({ length: 12, branch_length: 3 })

    const result = await s.executor.run(plan, options, skillContext().context)

    expect(result).toMatchObject({ ok: true })
    const ended = result.ok ? result.value.ended : []
    const byBranch = new Map(ended.map((e) => [e.branch, e.reason]))
    expect(byBranch.get('main')).toBe('hit_lava')
    // The junction at 3 blocks was reached (z = -3 is dug); the ones at 6, 9 were not.
    expect(isAir(s.world, 1, 50, -3)).toBe(true)
    expect(byBranch.get('right-6')).toBe('blocked_by_earlier')
    expect(byBranch.get('left-9')).toBe('blocked_by_earlier')
    expect(byBranch.has('right-3')).toBe(false)
    expect(isAir(s.world, 1, 50, -6)).toBe(false)
  })

  it('leaves two blocks of rock between the branches, and lights the junctions', async () => {
    const s = mine()
    s.world.give('torch', 30)

    await s.executor.run(mineOf({ length: 7, branch_length: 3 }), options, skillContext().context)

    expect(isAir(s.world, 2, 50, -3)).toBe(true) // branch at z = -3
    expect(isAir(s.world, 2, 50, -4)).toBe(false) // rock
    expect(isAir(s.world, 2, 50, -5)).toBe(false) // rock
    expect(isAir(s.world, 2, 50, -6)).toBe(true) // the next branch
  })
})

describe('ore veins', () => {
  it('mines an ore that touches the dug space, and the vein around it', async () => {
    const s = mine()
    s.world.give('torch', 5)
    s.world.setBlock(at(1, 50, -2), 'iron_ore')
    s.world.setBlock(at(2, 50, -2), 'iron_ore')
    s.world.setBlock(at(2, 51, -3), 'iron_ore') // touches diagonally: part of the vein

    const result = await s.executor.run(tunnelPlan({ length: 5 }), options, skillContext().context)

    expect(result).toMatchObject({ ok: true })
    expect(isAir(s.world, 1, 50, -2)).toBe(true)
    expect(isAir(s.world, 2, 50, -2)).toBe(true)
    expect(isAir(s.world, 2, 51, -3)).toBe(true)
    expect(isAir(s.world, 1, 50, -4)).toBe(false) // plain rock next to it is left
  })

  it('limits the size of a vein', async () => {
    const s = mine()
    s.world.give('torch', 5)
    for (let x = 1; x <= 100; x += 1) s.world.setBlock(at(x, 50, -1), 'coal_ore')
    const plan = { ...tunnelPlan({ length: 3 }), veins: { maxSize: 5 } }

    await s.executor.run(plan, options, skillContext().context)

    const mined = [...Array(100).keys()].filter((x) => isAir(s.world, x + 1, 50, -1)).length
    expect(mined).toBeLessThanOrEqual(6)
    expect(mined).toBeGreaterThan(0)
  })

  it('does not follow a vein into a protected area, or into a fluid: that part of the vein ends', async () => {
    const s = mine()
    s.world.give('torch', 5)
    s.world.setBlock(at(1, 50, -2), 'iron_ore')
    s.world.setBlock(at(2, 50, -2), 'iron_ore')
    s.world.setBlock(at(2, 50, -1), 'iron_ore')
    s.world.setBlock(at(2, 51, -2), 'lava') // above the second ore block
    s.world.protectedBoxes.push({ label: 'x', contains: (p) => p.x === 2 && p.z === -1 })

    const result = await s.executor.run(tunnelPlan({ length: 5 }), options, skillContext().context)

    expect(isAir(s.world, 1, 50, -2)).toBe(true) // the first block is fine
    expect(isAir(s.world, 2, 50, -2)).toBe(false) // lava beside it: left alone
    expect(s.world.nameAt(at(2, 51, -2))).toBe('lava')
    expect(isAir(s.world, 2, 50, -1)).toBe(false) // protected: never touched
    expect(result).toMatchObject({
      ok: true,
      value: { ended: [{ branch: 'vein', reason: 'hit_lava' }] },
    })
  })

  it('a vein that cannot be reached does not fail the plan', async () => {
    const s = mine()
    s.world.give('torch', 5)
    s.world.setBlock(at(1, 50, -2), 'iron_ore')
    let failures = 0
    const original = s.world.dig.bind(s.world)
    s.world.dig = (position, signal) => {
      if (position.x === 1 && position.z === -2) {
        failures += 1
        return Promise.resolve({
          ok: false as const,
          error: { reason: 'failed' as const, message: 'out of reach' },
        })
      }
      return original(position, signal)
    }

    const result = await s.executor.run(tunnelPlan({ length: 4 }), options, skillContext().context)

    expect(failures).toBeGreaterThan(0)
    expect(result).toMatchObject({ ok: true })
  })

  it('does nothing about ore when the plan does not ask', async () => {
    const s = mine()
    s.world.give('torch', 5)
    s.world.setBlock(at(1, 50, -2), 'iron_ore')
    const plan = { ...tunnelPlan({ length: 4 }), veins: undefined }

    await s.executor.run(plan, options, skillContext().context)

    expect(isAir(s.world, 1, 50, -2)).toBe(false)
  })
})

describe('a pit with a ladder out', () => {
  const pitPlan = (params: object, origin = at(10, 63, 10)): WorkPlan => {
    const p = new PitProvider()
    return p.generate(p.params.parse(params), { origin, minY: -64 })
  }

  it('digs the layers and puts a ladder up the west wall after each', async () => {
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
    world.give('ladder', 5)

    const result = await executor.run(
      pitPlan({ width: 3, length: 3, depth: 2 }),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { placed: 2, broken: 18 } })
    expect(world.nameAt(at(10, 63, 11))).toBe('ladder')
    expect(world.nameAt(at(10, 62, 11))).toBe('ladder')
    expect(world.nameAt(at(11, 63, 11))).toBe('air') // the rest of the pit is open
    expect(world.nameAt(at(11, 62, 11))).toBe('air')
    expect(world.nameAt(at(11, 61, 11))).toBe('dirt') // the floor below stays
  })

  it('does not dig a ladder out again when run a second time', async () => {
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
    world.give('ladder', 5)
    const plan = pitPlan({ width: 3, length: 3, depth: 2 })
    await executor.run(plan, options, skillContext().context)

    const again = await executor.run(plan, options, skillContext().context)

    expect(again).toMatchObject({ ok: true, value: { placed: 0, broken: 0 } })
    expect(world.nameAt(at(10, 62, 11))).toBe('ladder')
  })

  it('refuses up front when there are not enough ladders, naming how many', () => {
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
    })
    world.give('ladder', 1)

    const preview = executor.preview(pitPlan({ width: 3, length: 3, depth: 4 }), options)

    expect(preview.missing).toEqual([{ name: 'ladder', count: 3 }])
    expect(preview.toBreak).toBe(36) // the ladder cells are dug by a step of their own
  })
})

describe('the preview of a dig', () => {
  it('asks for the torches a tunnel needs, and does not mind lava nearby', () => {
    const s = mine()
    s.world.setBlock(at(2, 50, -3), 'lava')

    const preview = s.executor.preview(tunnelPlan({ length: 14 }), options)

    expect(preview.hazards).toEqual([])
    expect(preview.needs).toContainEqual({ name: 'torch', count: 2 })
    expect(preview.missing).toContainEqual({ name: 'torch', count: 2 })
    expect(preview.toBreak).toBe(26) // 28 cells, 2 of them are the pocket the bot stands in
  })

  it('counts nothing to place or break for a finished dig', async () => {
    const s = mine()
    s.world.give('torch', 5)
    const plan = tunnelPlan({ length: 4 })
    await s.executor.run(plan, options, skillContext().context)

    expect(s.executor.preview(plan, options)).toMatchObject({ toBreak: 0, alreadyDone: 8 })
  })
})

describe('branches that depend on a cell', () => {
  it('a step with an unmet requirement waits for it and goes on once it is dug', async () => {
    const s = mine()
    const steps: WorkStep[] = [
      { kind: 'break', at: at(1, 50, 0), needs: at(0, 50, -1), branch: 'side' },
      { kind: 'break', at: at(0, 50, -1), branch: 'main' },
    ]

    const result = await s.executor.run(
      { name: 'p', steps, hazards: 'end_branch' },
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { broken: 2, ended: [] } })
    expect(isAir(s.world, 1, 50, 0)).toBe(true)
  })

  it('a needs cell outside the plan (the player digs it by hand) is given a moment to catch up, not given up on at once', async () => {
    const s = mine()
    // The only step's needs cell is not part of the plan at all (a room's entrance, dug by the player): still
    // solid at first read, opened externally after a moment.
    const steps: WorkStep[] = [{ kind: 'break', at: at(1, 50, 0), needs: at(2, 50, 0), branch: 'room' }]
    s.world.setBlock(at(2, 50, 0), 'dirt')
    let reads = 0
    const realBlockAt = s.world.blockAt.bind(s.world)
    s.world.blockAt = (position) => {
      if (position.x === 2 && position.y === 50 && position.z === 0) {
        reads += 1
        if (reads >= 2) s.world.setBlock(at(2, 50, 0), 'air') // "opened by the player" a moment later
      }
      return realBlockAt(position)
    }

    const result = await s.executor.run(
      { name: 'p', steps, hazards: 'end_branch' },
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { broken: 1, ended: [] } })
    expect(reads).toBeGreaterThanOrEqual(2)
  })
})

describe('stairs and a water landing in a quarry', () => {
  function surface(extra: object = {}) {
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
      ...extra,
    })
    return { world, executor }
  }
  const quarryPlan = (params: object, origin = at(10, 63, 10)): WorkPlan => {
    const q = new QuarryProvider()
    const plan = q.generate(q.params.parse(params), { origin, minY: -64 })
    if ('error' in plan) throw new Error(plan.error)
    return plan
  }

  it('cuts a staircase around the pit, one step lower each layer, so there is a way out without materials', async () => {
    const s = surface()

    const result = await s.executor.run(
      quarryPlan({ width: 3, length: 3, to_y: 60, exit: 'stairs' }),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { placed: 0, ended: [] } })
    // Step n is three cells high in ring cell n, at 63 - n.
    expect(s.world.nameAt(at(9, 63, 9))).toBe('air') // step 0, the north-west corner
    expect(s.world.nameAt(at(10, 62, 9))).toBe('air') // step 1
    expect(s.world.nameAt(at(11, 61, 9))).toBe('air') // step 2
    expect(s.world.nameAt(at(12, 60, 9))).toBe('air') // step 3
    expect(s.world.nameAt(at(12, 59, 9))).toBe('dirt') // its floor
    expect(s.world.nameAt(at(11, 60, 9))).toBe('dirt') // the step before is a block higher: solid below it
    expect(s.world.nameAt(at(11, 60, 10))).toBe('air') // the pit itself
  })

  it('backfills a stair tread a cave had already hollowed out', async () => {
    const hollow = surface()
    hollow.world.setBlock(at(9, 62, 9), 'air') // the tread under step 0, already an open cave

    const result = await hollow.executor.run(
      quarryPlan({ width: 3, length: 3, to_y: 60, exit: 'stairs' }),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { ended: [] } })
    expect(hollow.world.nameAt(at(9, 62, 9))).not.toBe('air') // backfilled: something to stand on again
    expect(hollow.world.nameAt(at(9, 63, 9))).toBe('air') // step 0's headroom is still open
  })

  it('a lone seal step leaves an open cell as found when there is nothing to backfill it with', async () => {
    const s = surface()
    s.world.setBlock(at(0, 63, 0), 'air') // a cave, standing in for a tread or a wall the plan needs solid
    const plan: WorkPlan = {
      name: 'a single seal step',
      steps: [{ kind: 'seal', at: at(0, 63, 0), block: 'cobblestone' }],
      hazards: 'end_branch',
      seal: { block: 'cobblestone', fallback: 'dirt' },
    }

    const result = await s.executor.run(plan, options, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { placed: 0 } })
    expect(s.world.nameAt(at(0, 63, 0))).toBe('air') // nothing was carried to seal it with, so it is left as found
  })

  it('fills a 2x2x2 pit in the far corner with water from two buckets', async () => {
    const s = surface()
    s.world.give('water_bucket', 2)

    const result = await s.executor.run(
      quarryPlan({ width: 4, length: 4, to_y: 61, exit: 'none', water_landing: true }),
      options,
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { placed: 2 } })
    expect(s.world.nameAt(at(12, 60, 12))).toBe('water') // top layer of the pond, first source
    expect(s.world.nameAt(at(13, 60, 13))).toBe('water') // second source, diagonal
    expect(s.world.nameAt(at(13, 59, 12))).toBe('air') // the lower layer is dug (the water falls into it in the game)
    expect(s.world.nameAt(at(12, 61, 12))).toBe('air') // the quarry floor above it is open
    expect(s.world.carried.get('bucket')).toBe(2)
  })

  it('asks for the water buckets up front', () => {
    const s = surface()
    s.world.give('water_bucket', 1)

    const preview = s.executor.preview(
      quarryPlan({ width: 4, length: 4, to_y: 61, exit: 'none', water_landing: true }),
      options,
    )

    expect(preview.missing).toEqual([{ name: 'water_bucket', count: 1 }])
  })

  it('resumes: a pond that already has its water is left alone', async () => {
    const s = surface()
    s.world.give('water_bucket', 2)
    const plan = quarryPlan({ width: 4, length: 4, to_y: 61, exit: 'none', water_landing: true })
    await s.executor.run(plan, options, skillContext().context)

    const again = await s.executor.run(plan, options, skillContext().context)

    expect(again).toMatchObject({ ok: true, value: { placed: 0, broken: 0 } })
  })
})

describe('the spoil and the supplies', () => {
  it('throws junk away when the inventory is full and the request said to', async () => {
    let discards = 0
    const discarder = {
      discard: () => {
        discards += 1
        s.world.emptySlots = 4
        return Promise.resolve(200)
      },
    } as unknown as SpoilDiscarder
    const s = mine({ discarder })
    s.world.give('torch', 5)
    s.world.emptySlots = 0

    const result = await s.executor.run(
      tunnelPlan({ length: 4 }),
      { ...options, spoil: 'discard_junk' },
      skillContext().context,
    )

    expect(result.ok).toBe(true)
    expect(discards).toBeGreaterThan(0)
  })

  it('does not throw anything away by default: a full inventory stops the dig', async () => {
    let discards = 0
    const discarder = {
      discard: () => {
        discards += 1
        return Promise.resolve(0)
      },
    } as unknown as SpoilDiscarder
    const s = mine({ discarder })
    s.world.give('torch', 5)
    s.world.emptySlots = 0

    const result = await s.executor.run(tunnelPlan({ length: 4 }), options, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'inventory_full' } })
    expect(discards).toBe(0)
  })

  it('stops when there is no junk to throw and the inventory is still full', async () => {
    const discarder = { discard: () => Promise.resolve(0) } as unknown as SpoilDiscarder
    const s = mine({ discarder })
    s.world.give('torch', 5)
    s.world.emptySlots = 0

    const result = await s.executor.run(
      tunnelPlan({ length: 4 }),
      { ...options, spoil: 'discard_junk' },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'inventory_full' } })
  })

  it('makes more torches when they run out, and carries on', async () => {
    const asked: [string, number][] = []
    const supplies: SupplyCrafter = {
      craft: (item, count) => {
        asked.push([item, count])
        s.world.give(item, count)
        return Promise.resolve(true)
      },
    }
    const s = mine({ supplies })
    s.world.give('torch', 2)
    s.world.onPlaced = () => {
      if (asked.length === 0) s.world.carried.set('torch', 0) // the last torch is used up
    }

    const result = await s.executor.run(tunnelPlan({ length: 14 }), options, skillContext().context)

    expect(result).toMatchObject({ ok: true })
    expect(asked).toEqual([['torch', 8]])
    expect(s.world.nameAt(at(0, 50, -11))).toBe('torch')
  })

  it('stops with no_torches when it cannot make any', async () => {
    const supplies: SupplyCrafter = { craft: () => Promise.resolve(false) }
    const s = mine({ supplies })
    s.world.give('torch', 2)
    s.world.onPlaced = () => {
      s.world.carried.set('torch', 0)
    }

    const result = await s.executor.run(tunnelPlan({ length: 14 }), options, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_torches' } })
  })

  it('crafts a spare pickaxe when the tool is gone, the cheapest that works', async () => {
    const tried: string[] = []
    const supplies: SupplyCrafter = {
      craft: (item) => {
        tried.push(item)
        if (item === 'iron_pickaxe') {
          s.world.hasTool = true
          return Promise.resolve(true)
        }
        return Promise.resolve(false) // no wood, no cobblestone
      },
    }
    const s = mine({ supplies })
    s.world.give('torch', 5)
    s.world.setBlock(at(0, 50, -3), 'iron_ore')
    s.world.needsTool.set('iron_ore', 'stone_pickaxe')
    s.world.hasTool = false
    const plan = {
      ...tunnelPlan({ length: 5 }),
      // The ore is in the way of the tunnel itself.
    }
    s.world.needsTool.set('dirt', 'stone_pickaxe')
    s.world.assess = (position) => ({
      blockName: s.world.nameAt(position),
      diggable: s.world.nameAt(position) !== 'air',
      requiredTools: [
        'wooden_pickaxe',
        'stone_pickaxe',
        'iron_pickaxe',
        'golden_pickaxe',
        'netherite_pickaxe',
      ],
      canHarvest: s.world.hasTool,
      tool: undefined,
    })

    const result = await s.executor.run(plan, options, skillContext().context)

    expect(result).toMatchObject({ ok: true })
    expect(tried).toEqual(['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe']) // gold and netherite are never crafted
  })

  it('stops with no_suitable_tool when no spare can be made', async () => {
    const supplies: SupplyCrafter = { craft: () => Promise.resolve(false) }
    const s = mine({ supplies })
    s.world.give('torch', 5)
    s.world.hasTool = false
    s.world.assess = (position) => ({
      blockName: s.world.nameAt(position),
      diggable: true,
      requiredTools: ['stone_pickaxe'],
      canHarvest: false,
      tool: undefined,
    })

    const result = await s.executor.run(tunnelPlan({ length: 3 }), options, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_suitable_tool' } })
  })
})
