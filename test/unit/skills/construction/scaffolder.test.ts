import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import { Scaffolder, type TowerRequest } from '../../../../src/skills/construction/scaffolder.js'
import { ConstructionWorld } from '../../../fakes/construction-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { AutoScheduler, FakeDroppedItems } from '../../../fakes/gathering-fakes.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })
const live = () => new AbortController().signal

function setup() {
  const world = new ConstructionWorld()
  const scheduler = new AutoScheduler(new FakeClock(0))
  const scaffolder = new Scaffolder({
    blocks: world,
    placer: world,
    digger: world,
    locomotion: world,
    navigator: world,
    vitals: world,
    guard: world,
    drops: new DropCollector({ drops: new FakeDroppedItems(), navigator: world, scheduler }),
    scheduler,
  })
  return { world, scaffolder }
}

const request = (patch: Partial<TowerRequest> = {}): TowerRequest => ({
  target: at(3, 70, 5),
  from: at(0.5, 64, 0.5),
  reserved: new Set(),
  maxHeight: 12,
  ...patch,
})

describe('Scaffolder.plan', () => {
  it('finds a ground cell beside the target and the height that brings it within reach', () => {
    const { scaffolder } = setup()

    const plan = scaffolder.plan(request())

    expect(plan).toBeDefined()
    expect(plan?.base.y).toBe(64) // the ground is at y = 64 (feet)
    expect(Math.hypot((plan?.base.x ?? 0) - 3, (plan?.base.z ?? 0) - 5)).toBeLessThanOrEqual(3)
    // A block of 7 above the ground is not reachable from the ground, but a couple of blocks up it is.
    expect(plan?.height).toBeGreaterThanOrEqual(2)
    expect(plan?.height).toBeLessThanOrEqual(3)
  })

  it('wants a taller tower for a higher target', () => {
    const { scaffolder } = setup()

    const low = scaffolder.plan(request({ target: at(3, 68, 5) }))
    const high = scaffolder.plan(request({ target: at(3, 76, 5) }))

    expect(high?.height ?? 0).toBeGreaterThan(low?.height ?? 0)
  })

  it('gives up when the limit is too low', () => {
    const { scaffolder } = setup()

    expect(scaffolder.plan(request({ target: at(3, 76, 5), maxHeight: 2 }))).toBeUndefined()
  })

  it('never puts the tower in a cell that is still to be built', () => {
    const { scaffolder } = setup()
    const reserved = new Set<string>()
    for (let x = 0; x <= 6; x += 1)
      for (let y = 64; y <= 80; y += 1) reserved.add(`${String(x)},${String(y)},4`)

    const plan = scaffolder.plan(request({ reserved }))

    expect(plan?.base.z).not.toBe(4)
  })

  it('stays out of protected areas, away from lava, and does not build under a ceiling', () => {
    const blocked = setup()
    blocked.world.protectedBoxes.push({ label: 'village', contains: () => true })
    expect(blocked.scaffolder.plan(request())).toBeUndefined()

    const lava = setup()
    for (let x = -1; x <= 8; x += 1)
      for (let z = 0; z <= 10; z += 1) lava.world.setBlock(at(x, 64, z), 'lava')
    expect(lava.scaffolder.plan(request())).toBeUndefined()

    const ceiling = setup()
    for (let x = -1; x <= 8; x += 1)
      for (let z = 0; z <= 10; z += 1) ceiling.world.setBlock(at(x, 67, z), 'stone')
    expect(ceiling.scaffolder.plan(request())).toBeUndefined()
  })

  it('prefers a place outside the building when it can', () => {
    const { scaffolder } = setup()
    const inside = (cell: Position): boolean =>
      cell.x >= 1 && cell.x <= 5 && cell.z >= 3 && cell.z <= 7

    const plan = scaffolder.plan(request({ avoid: inside }))

    expect(inside(plan?.base ?? at(2, 64, 4))).toBe(false)
  })
})

describe('Scaffolder.plan, through leaves', () => {
  /** Leaves fill every free column around the target, from the ground up to well above it. */
  function canopy() {
    const s = setup()
    for (let x = -1; x <= 8; x += 1)
      for (let z = 0; z <= 10; z += 1)
        for (let y = 66; y <= 80; y += 1)
          if (!(x === 3 && z === 5)) s.world.setBlock(at(x, y, z), 'oak_leaves')
    return s
  }
  const leaf = (cell: Position): boolean => canopy_world?.nameAt(cell) === 'oak_leaves'
  let canopy_world: ReturnType<typeof setup>['world'] | undefined

  it('refuses a column of leaves unless told they may be cut', () => {
    const { scaffolder, world } = canopy()
    canopy_world = world

    expect(scaffolder.plan(request())).toBeUndefined()
  })

  it('uses a column of leaves when they may be cut, and lists the cells to dig', () => {
    const { scaffolder, world } = canopy()
    canopy_world = world

    const plan = scaffolder.plan(request({ passable: leaf, maxClear: 12 }))

    expect(plan).toBeDefined()
    expect(plan?.clear?.length).toBeGreaterThan(0)
    for (const cell of plan?.clear ?? []) expect(world.nameAt(cell)).toBe('oak_leaves')
  })

  it('refuses a column that needs more cuts than the limit', () => {
    const { scaffolder, world } = canopy()
    canopy_world = world

    expect(scaffolder.plan(request({ passable: leaf, maxClear: 1 }))).toBeUndefined()
  })

  it('prefers a clear column to one with leaves in it, even a little farther away', () => {
    const { scaffolder, world } = setup()
    canopy_world = world
    world.setBlock(at(2, 66, 5), 'oak_leaves') // the nearest column has a leaf in it

    const plan = scaffolder.plan(request({ target: at(3, 70, 5), passable: leaf, maxClear: 12 }))

    expect(plan?.clear ?? []).toEqual([])
  })

  it('does not treat a leaf that is not passable as free', () => {
    const { scaffolder, world } = canopy()
    canopy_world = world

    expect(scaffolder.plan(request({ passable: () => false, maxClear: 12 }))).toBeUndefined()
  })
})

describe('Scaffolder.raise', () => {
  it('builds the tower and ends with the bot on top of it', async () => {
    const { world, scaffolder } = setup()
    world.give('cobblestone', 10)

    const raised = await scaffolder.raise({ base: at(2, 64, 3), height: 3 }, 'cobblestone', live())

    expect(raised.ok).toBe(true)
    const tower = raised.ok ? raised.value : undefined
    expect(tower?.cells).toEqual([at(2, 64, 3), at(2, 65, 3), at(2, 66, 3)])
    expect(world.nameAt(at(2, 66, 3))).toBe('cobblestone')
    expect(world.bot.y).toBe(67) // standing on the top block
    expect(world.carried.get('cobblestone')).toBe(7)
    expect(world.jumps).toBe(3)
  })

  it('walks to the foot of the tower first', async () => {
    const { world, scaffolder } = setup()
    world.give('cobblestone', 10)
    world.bot = at(30.5, 64, 30.5)

    await scaffolder.raise({ base: at(2, 64, 3), height: 1 }, 'cobblestone', live())

    expect(world.trips[0]).toEqual(at(2.5, 64, 3.5))
  })

  it('tries a block again when placing it fails once', async () => {
    const { world, scaffolder } = setup()
    world.give('cobblestone', 10)
    world.placeFailures = [{ reason: 'failed', message: 'lag' }]

    const raised = await scaffolder.raise({ base: at(2, 64, 3), height: 2 }, 'cobblestone', live())

    expect(raised.ok).toBe(true)
    expect(world.nameAt(at(2, 65, 3))).toBe('cobblestone')
  })

  it('reports a tower that could not be finished, with what was built', async () => {
    const { world, scaffolder } = setup()
    world.give('cobblestone', 10)
    world.placeFailures = [
      undefined,
      ...Array.from({ length: 6 }, () => ({ reason: 'failed' as const, message: 'no' })),
    ]

    const raised = await scaffolder.raise({ base: at(2, 64, 3), height: 3 }, 'cobblestone', live())

    expect(raised).toMatchObject({ ok: false, error: { reason: 'place_failed' } })
    expect(!raised.ok && raised.error.tower.cells).toHaveLength(1)
  })

  it('reports a bot that cannot jump', async () => {
    const { world, scaffolder } = setup()
    world.give('cobblestone', 10)
    world.canJump = false

    const raised = await scaffolder.raise({ base: at(2, 64, 3), height: 2 }, 'cobblestone', live())

    expect(raised).toMatchObject({ ok: false, error: { reason: 'jump_failed' } })
  })

  it('fails when the foot of the tower cannot be reached, and when cancelled', async () => {
    const { world, scaffolder } = setup()
    world.give('cobblestone', 10)
    world.navFailures = [{ reason: 'unreachable', message: 'no path' }]
    expect(
      await scaffolder.raise({ base: at(2, 64, 3), height: 1 }, 'cobblestone', live()),
    ).toMatchObject({
      ok: false,
      error: { reason: 'unreachable' },
    })

    const controller = new AbortController()
    controller.abort()
    expect(
      await scaffolder.raise({ base: at(2, 64, 3), height: 1 }, 'cobblestone', controller.signal),
    ).toMatchObject({
      ok: false,
      error: { reason: 'aborted' },
    })
  })

  it('can add one more block to a tower', async () => {
    const { world, scaffolder } = setup()
    world.give('cobblestone', 10)
    const raised = await scaffolder.raise({ base: at(2, 64, 3), height: 1 }, 'cobblestone', live())
    if (!raised.ok) throw new Error('setup failed')

    const more = await scaffolder.pillarOnce(raised.value, live())

    expect(more.ok).toBe(true)
    expect(raised.value.cells).toHaveLength(2)
    expect(world.bot.y).toBe(66)
  })

  it('digs the leaves that stand in the tower column before climbing into them', async () => {
    const { world, scaffolder } = setup()
    world.give('cobblestone', 10)
    world.setBlock(at(2, 66, 3), 'oak_leaves')
    world.setBlock(at(2, 67, 3), 'oak_leaves')
    const plan = { base: at(2, 64, 3), height: 3, clear: [at(2, 66, 3), at(2, 67, 3)] }

    const raised = await scaffolder.raise(plan, 'cobblestone', live())

    expect(raised.ok).toBe(true)
    expect(raised.ok && raised.value.leavesCut).toBe(2)
    expect(world.nameAt(at(2, 66, 3))).toBe('cobblestone')
    expect(world.log.filter((line) => line.startsWith('dig'))).toHaveLength(2)
  })

  it('digs a leaf above the planned height when the tower has to grow, if the plan allows it', async () => {
    const { world, scaffolder } = setup()
    world.give('cobblestone', 10)
    world.setBlock(at(2, 67, 3), 'oak_leaves')
    world.setBlock(at(2, 68, 3), 'oak_leaves')
    const raised = await scaffolder.raise(
      { base: at(2, 64, 3), height: 1, mayCut: (cell) => world.nameAt(cell) === 'oak_leaves' },
      'cobblestone',
      live(),
    )
    if (!raised.ok) throw new Error('setup failed')

    const more = await scaffolder.pillarOnce(raised.value, live())
    const evenMore = await scaffolder.pillarOnce(raised.value, live())

    expect(more.ok && evenMore.ok).toBe(true)
    expect(raised.value.leavesCut).toBe(2)
    expect(raised.value.cells).toHaveLength(3)
  })

  it('only digs cells the plan named', async () => {
    const { world, scaffolder } = setup()
    world.give('cobblestone', 10)
    world.setBlock(at(2, 66, 3), 'oak_leaves')

    const raised = await scaffolder.raise({ base: at(2, 64, 3), height: 3 }, 'cobblestone', live())

    // A leaf nobody said may be cut is left alone, and the bot cannot climb into it.
    expect(world.log.filter((line) => line.startsWith('dig'))).toEqual([])
    expect(raised.ok && raised.value.leavesCut).toBe(0)
  })

  it('stops when a leaf will not break, saying so', async () => {
    const { world, scaffolder } = setup()
    world.give('cobblestone', 10)
    world.setBlock(at(2, 66, 3), 'oak_leaves')
    world.digFailures = [{ reason: 'out_of_reach', message: 'too hard' }]

    const raised = await scaffolder.raise(
      { base: at(2, 64, 3), height: 3, clear: [at(2, 66, 3)] },
      'cobblestone',
      live(),
    )

    expect(raised.ok).toBe(false)
    expect(!raised.ok && raised.error.message).toContain('oak_leaves')
  })

  it('needs a connection', async () => {
    const { world, scaffolder } = setup()
    world.give('cobblestone', 10)
    const raised = await scaffolder.raise({ base: at(2, 64, 3), height: 1 }, 'cobblestone', live())
    if (!raised.ok) throw new Error('setup failed')
    world.read = () => undefined

    expect(await scaffolder.pillarOnce(raised.value, live())).toMatchObject({
      ok: false,
      error: { reason: 'not_connected' },
    })
  })
})

describe('Scaffolder.lower', () => {
  async function tower(height: number) {
    const s = setup()
    s.world.give('cobblestone', 20)
    const raised = await s.scaffolder.raise({ base: at(2, 64, 3), height }, 'cobblestone', live())
    if (!raised.ok) throw new Error('setup failed')
    return { ...s, tower: raised.value }
  }

  it('takes the tower down from the top, gets the blocks back, and ends on the ground', async () => {
    const t = await tower(4)

    const left = await t.scaffolder.lower(t.tower)

    expect(left).toEqual([])
    expect(t.world.builtBlocks().size).toBe(0)
    expect(t.world.bot.y).toBe(64)
    expect(t.world.carried.get('cobblestone')).toBe(20)
    expect(t.tower.cells).toEqual([])
    const digs = t.world.log.filter((line) => line.startsWith('dig'))
    expect(digs).toEqual(['dig 2,67,3', 'dig 2,66,3', 'dig 2,65,3', 'dig 2,64,3']) // from the top
  })

  it('comes down even when the work was cancelled', async () => {
    const t = await tower(2)
    // The signal that cancelled the work is not used for the descent: nothing is passed in.

    await t.scaffolder.lower(t.tower)

    expect(t.world.bot.y).toBe(64)
  })

  it('reports the blocks it could not remove', async () => {
    const t = await tower(2)
    t.world.digFailures = [{ reason: 'failed', message: 'stuck' }]

    const left = await t.scaffolder.lower(t.tower)

    expect(left).toEqual([at(2, 65, 3)])
  })

  it('skips cells that are already gone', async () => {
    const t = await tower(2)
    t.world.setBlock(at(2, 65, 3), 'air')

    const left = await t.scaffolder.lower(t.tower)

    expect(left).toEqual([])
  })
})
