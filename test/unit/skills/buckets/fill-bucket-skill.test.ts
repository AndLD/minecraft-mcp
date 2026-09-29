import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import {
  FillBucketSkill,
  type FillBucketInput,
} from '../../../../src/skills/buckets/fill-bucket-skill.js'
import { LiquidSpotFinder } from '../../../../src/skills/buckets/liquid-spot.js'
import { skillContext } from '../../../fakes/gathering-fakes.js'
import { BucketWorld } from '../../../fakes/bucket-fakes.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })
const SURFACE = 63

const water: FillBucketInput = { liquid: 'water', count: 1, at: undefined, maxDistance: 24 }
const lava: FillBucketInput = { liquid: 'lava', count: 1, at: undefined, maxDistance: 24 }

function setup() {
  const world = new BucketWorld()
  const skill = new FillBucketSkill({
    vitals: world,
    blocks: world,
    liquids: world,
    filler: world,
    inventory: world,
    navigator: world,
    guard: world,
    spots: new LiquidSpotFinder(world),
  })
  return { world, skill }
}

/** Ground disappears around a point, so there is nothing to stand on within reach of it. */
function hollowOut(world: BucketWorld, centre: Position, radius: number): void {
  for (let x = centre.x - radius; x <= centre.x + radius; x += 1)
    for (let z = centre.z - radius; z <= centre.z + radius; z += 1)
      for (let y = SURFACE - 4; y <= SURFACE; y += 1) world.setBlock(at(x, y, z), 'air')
}

describe('FillBucketSkill: water', () => {
  it('walks to the nearest source and fills the bucket, and a pool with two sources beside each other stays', async () => {
    const { world, skill } = setup()
    world.pool('water', at(6, SURFACE, 0), at(7, SURFACE, 1))
    const { context } = skillContext()

    const result = await skill.run(water, context)

    expect(result).toMatchObject({
      ok: true,
      value: { liquid: 'water', item: 'water_bucket', filled: 1, requested: 1, poolRefills: true },
    })
    expect(world.carried.get('water_bucket')).toBe(1)
    expect(world.carried.get('bucket')).toBe(0)
    expect(world.trips).toHaveLength(1)
    // The bot ended within reach and on open ground, not in the pool.
    expect(world.blockAt(world.bot)).toBe('air')
    expect(world.taken).toHaveLength(1)
    expect(world.liquidAt(world.taken[0] as Position)).toMatchObject({ source: true })
  })

  it('drains a lone source and says so', async () => {
    const { world, skill } = setup()
    world.setBlock(at(6, SURFACE, 0), 'water')
    const { context } = skillContext()

    const result = await skill.run(water, context)

    expect(result).toMatchObject({ ok: true, value: { filled: 1, poolRefills: false } })
    expect(world.blockAt(at(6, SURFACE, 0))).toBe('air')
    if (result.ok) expect(result.value.message).toContain('drained')
  })

  it('does not stay put when the bot already stands within reach of the source', async () => {
    const { world, skill } = setup()
    world.setBlock(at(2, SURFACE, 0), 'water')
    const { context } = skillContext()

    const result = await skill.run(water, context)

    expect(result).toMatchObject({ ok: true, value: { filled: 1 } })
    expect(world.trips).toHaveLength(0)
  })

  it('prefers a source that refills itself when it is only a little further away', async () => {
    const { world, skill } = setup()
    world.setBlock(at(3, SURFACE, 0), 'water') // alone, nearest
    world.pool('water', at(6, SURFACE, 5), at(7, SURFACE, 6))
    const { context } = skillContext()

    const result = await skill.run(water, context)

    expect(result).toMatchObject({ ok: true, value: { poolRefills: true } })
    expect(world.liquidAt(at(3, SURFACE, 0))).toMatchObject({ source: true })
  })

  it('does not detour far for a refilling pool', async () => {
    const { world, skill } = setup()
    world.setBlock(at(3, SURFACE, 0), 'water')
    world.pool('water', at(20, SURFACE, 0), at(21, SURFACE, 1))
    const { context } = skillContext()

    const result = await skill.run(water, context)

    expect(result).toMatchObject({ ok: true, value: { poolRefills: false } })
    expect(world.taken).toEqual([at(3, SURFACE, 0)])
  })

  it('takes the named source', async () => {
    const { world, skill } = setup()
    world.pool('water', at(4, SURFACE, 0), at(4, SURFACE, 1))
    world.setBlock(at(9, SURFACE, 9), 'water')
    const { context } = skillContext()

    const result = await skill.run({ ...water, at: at(9, SURFACE, 9) }, context)

    expect(result).toMatchObject({ ok: true, value: { from: [at(9, SURFACE, 9)] } })
  })

  it('fills as many buckets as asked and carried, taking from a refilling pool again and again', async () => {
    const { world, skill } = setup()
    world.give('bucket', 2)
    world.pool('water', at(4, SURFACE, 0), at(5, SURFACE, 1))
    const { context, progress } = skillContext()

    const result = await skill.run({ ...water, count: 3 }, context)

    expect(result).toMatchObject({
      ok: true,
      value: { filled: 3, requested: 3, poolRefills: true },
    })
    expect(world.carried.get('water_bucket')).toBe(3)
    expect(progress).toEqual(['Filled 1 of 3', 'Filled 2 of 3', 'Filled 3 of 3'])
  })

  it('fills only what the empty buckets allow and says why it stopped', async () => {
    const { world, skill } = setup()
    world.give('bucket', 1)
    world.pool('water', at(4, SURFACE, 0), at(5, SURFACE, 1))
    const { context } = skillContext()

    const result = await skill.run({ ...water, count: 5 }, context)

    expect(result).toMatchObject({ ok: true, value: { filled: 2, requested: 5 } })
    if (result.ok) expect(result.value.stoppedBecause).toContain('2 empty bucket')
  })

  it('reports a partial result when the sources run out', async () => {
    const { world, skill } = setup()
    world.give('bucket', 1)
    world.setBlock(at(4, SURFACE, 0), 'water')
    const { context } = skillContext()

    const result = await skill.run({ ...water, count: 2 }, context)

    expect(result).toMatchObject({ ok: true, value: { filled: 1, requested: 2 } })
    if (result.ok) expect(result.value.stoppedBecause).toContain('no water')
  })

  it('fails no_bucket with what to craft, without crafting', async () => {
    const { world, skill } = setup()
    world.carried.set('bucket', 0)
    world.setBlock(at(4, SURFACE, 0), 'water')
    const { context } = skillContext()

    const result = await skill.run(water, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_bucket' } })
    if (!result.ok) expect(result.error.message).toContain('3 iron ingots')
    expect(world.trips).toHaveLength(0)
  })

  it('fails inventory_full when a filled bucket would have no slot', async () => {
    const { world, skill } = setup()
    world.give('bucket', 1)
    world.emptySlots = 0
    world.setBlock(at(4, SURFACE, 0), 'water')
    const { context } = skillContext()

    const result = await skill.run(water, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'inventory_full' } })
  })

  it('fails no_source when there is no water in range', async () => {
    const { world, skill } = setup()
    world.setBlock(at(40, SURFACE, 0), 'water')
    const { context } = skillContext()

    const result = await skill.run(water, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_source' } })
  })

  it('does not take flowing water, and says that only flowing water was found', async () => {
    const { world, skill } = setup()
    world.flowing('water', at(4, SURFACE, 0), 3)
    world.flowing('water', at(4, SURFACE, 1), 8)
    const { context } = skillContext()

    const result = await skill.run(water, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_source' } })
    if (!result.ok) expect(result.error.message).toContain('flowing')
    expect(world.taken).toHaveLength(0)
  })

  it('skips flowing cells that are nearer than a source', async () => {
    const { world, skill } = setup()
    world.flowing('water', at(3, SURFACE, 0))
    world.setBlock(at(6, SURFACE, 0), 'water')
    const { context } = skillContext()

    const result = await skill.run(water, context)

    expect(result).toMatchObject({ ok: true, value: { from: [at(6, SURFACE, 0)] } })
  })

  it.each([
    [
      'is flowing',
      (world: BucketWorld) => {
        world.flowing('water', at(4, SURFACE, 0), 2)
      },
      'flowing',
    ],
    [
      'is not liquid',
      (world: BucketWorld) => {
        world.setBlock(at(4, SURFACE, 0), 'stone')
      },
      'no water',
    ],
    [
      'is the other liquid',
      (world: BucketWorld) => {
        world.setBlock(at(4, SURFACE, 0), 'lava')
      },
      'lava',
    ],
  ])('fails not_a_source when the named block %s', async (_what, prepare, text) => {
    const { world, skill } = setup()
    prepare(world)
    const { context } = skillContext()

    const result = await skill.run({ ...water, at: at(4, SURFACE, 0) }, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'not_a_source' } })
    if (!result.ok) expect(result.error.message).toContain(text)
  })

  it('leaves water inside a protected area alone', async () => {
    const { world, skill } = setup()
    world.setBlock(at(4, SURFACE, 0), 'water')
    world.protectedBoxes.push({ label: 'Pond', contains: (p) => p.x === 4 })
    const { context } = skillContext()

    const result = await skill.run(water, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'protected_area' } })
    expect(world.taken).toHaveLength(0)
  })

  it('takes an unprotected source when the nearest one is protected', async () => {
    const { world, skill } = setup()
    world.setBlock(at(4, SURFACE, 0), 'water')
    world.setBlock(at(8, SURFACE, 0), 'water')
    world.protectedBoxes.push({ label: 'Pond', contains: (p) => p.x === 4 })
    const { context } = skillContext()

    const result = await skill.run(water, context)

    expect(result).toMatchObject({ ok: true, value: { from: [at(8, SURFACE, 0)] } })
  })

  it('reports unreachable when the walk fails', async () => {
    const { world, skill } = setup()
    world.setBlock(at(9, SURFACE, 0), 'water')
    world.navFailures = [{ reason: 'unreachable', message: 'no path' }]
    const { context } = skillContext()

    const result = await skill.run(water, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'unreachable' } })
  })

  it('reports the failure of the take itself', async () => {
    const { world, skill } = setup()
    world.setBlock(at(2, SURFACE, 0), 'water')
    world.fillFailures = [{ reason: 'failed', message: 'the bucket did not fill' }]
    const { context } = skillContext()

    const result = await skill.run(water, context)

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'failed', message: 'the bucket did not fill' },
    })
  })

  it('is cancelled on the way', async () => {
    const { world, skill } = setup()
    world.setBlock(at(9, SURFACE, 0), 'water')
    const { context, controller } = skillContext()
    controller.abort()

    const result = await skill.run(water, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(world.taken).toHaveLength(0)
  })

  it('is cancelled between two buckets, keeping the first', async () => {
    const { world, skill } = setup()
    world.give('bucket', 1)
    world.pool('water', at(2, SURFACE, 0), at(3, SURFACE, 1))
    const { context, controller } = skillContext()
    world.afterTake = () => {
      controller.abort()
    }

    const result = await skill.run({ ...water, count: 2 }, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(world.taken).toHaveLength(1)
  })

  it('fails when not connected', async () => {
    const { world, skill } = setup()
    world.read = () => undefined
    const { context } = skillContext()

    const result = await skill.run(water, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
  })
})

describe('FillBucketSkill: lava', () => {
  const pool = (world: BucketWorld) => {
    world.pool('lava', at(6, SURFACE, -1), at(8, SURFACE, 1))
  }

  it('takes lava from a spot no lava can reach: lava-free all around and above, the source at its side', async () => {
    const { world, skill } = setup()
    pool(world)
    const finder = new LiquidSpotFinder(world)
    const { context } = skillContext()

    const result = await skill.run(lava, context)

    expect(result).toMatchObject({
      ok: true,
      value: { liquid: 'lava', item: 'lava_bucket', filled: 1, poolRefills: undefined },
    })
    expect(world.carried.get('lava_bucket')).toBe(1)
    const stood = world.takenFrom[0] as Position
    expect(finder.lavaSafe(stood)).toBe(true)
    // Nothing but ground is beside the bot, and the lava is not right next to it.
    const source = world.taken[0] as Position
    expect(
      Math.hypot(stood.x - (source.x + 0.5), stood.z - (source.z + 0.5)),
    ).toBeGreaterThanOrEqual(2)
    expect(world.blockAt(world.bot)).toBe('air')
  })

  it('never walks to a spot beside the lava while several buckets are filled', async () => {
    const { world, skill } = setup()
    world.give('bucket', 2)
    pool(world)
    const finder = new LiquidSpotFinder(world)
    const { context } = skillContext()

    const result = await skill.run({ ...lava, count: 3 }, context)

    expect(result).toMatchObject({ ok: true, value: { filled: 3 } })
    for (const stood of world.takenFrom) expect(finder.lavaSafe(stood)).toBe(true)
    // Each take reads the pool again: nothing is taken twice.
    expect(new Set(world.taken.map((cell) => `${String(cell.x)},${String(cell.z)}`)).size).toBe(3)
  })

  it('refuses when there is nowhere safe to stand within reach of the source', async () => {
    const { world, skill } = setup()
    hollowOut(world, at(6, SURFACE, 0), 6)
    world.setBlock(at(6, SURFACE, 0), 'lava')
    const { context } = skillContext()

    const result = await skill.run(lava, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_safe_spot' } })
    expect(world.taken).toHaveLength(0)
  })

  it('refuses when the only ground in reach is beside more lava', async () => {
    const { world, skill } = setup()
    // A ring of flowing lava around the source: every place within reach has lava next to it.
    world.setBlock(at(6, SURFACE, 0), 'lava')
    for (let x = 2; x <= 10; x += 1)
      for (let z = -4; z <= 4; z += 1)
        if (x !== 6 || z !== 0) world.flowing('lava', at(x, SURFACE, z), 2)
    const { context } = skillContext()

    const result = await skill.run(lava, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_safe_spot' } })
    expect(world.taken).toHaveLength(0)
  })

  it('does not stand under lava that could drip onto it', async () => {
    const { world, skill } = setup()
    world.setBlock(at(6, SURFACE, 0), 'lava')
    // A lava ceiling over every cell near the source, well above head height.
    for (let x = 1; x <= 11; x += 1)
      for (let z = -5; z <= 5; z += 1) world.setBlock(at(x, SURFACE + 4, z), 'lava')
    const { context } = skillContext()

    const result = await skill.run(lava, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_safe_spot' } })
  })

  it('refuses a source beside something a player built, and says to name the block', async () => {
    const { world, skill } = setup()
    world.setBlock(at(6, SURFACE, 0), 'lava')
    world.setBlock(at(6, SURFACE + 1, 3), 'oak_planks')
    const { context } = skillContext()

    const result = await skill.run(lava, context)

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'structure_nearby', detail: { structure: 'oak_planks' } },
    })
    if (!result.ok) expect(result.error.message).toContain('"at"')
    expect(world.taken).toHaveLength(0)
  })

  it('takes a source beside a build when the player named the block', async () => {
    const { world, skill } = setup()
    world.setBlock(at(6, SURFACE, 0), 'lava')
    world.setBlock(at(6, SURFACE + 1, 3), 'oak_planks')
    const { context } = skillContext()

    const result = await skill.run({ ...lava, at: at(6, SURFACE, 0) }, context)

    expect(result).toMatchObject({ ok: true, value: { from: [at(6, SURFACE, 0)] } })
  })

  it('takes a source that is far from a build instead of the one beside it', async () => {
    const { world, skill } = setup()
    world.setBlock(at(6, SURFACE, 0), 'lava')
    world.setBlock(at(6, SURFACE + 1, 2), 'chest')
    world.setBlock(at(30, SURFACE, 0), 'lava')
    const { context } = skillContext()

    const result = await skill.run({ ...lava, maxDistance: 40 }, context)

    expect(result).toMatchObject({ ok: true, value: { from: [at(30, SURFACE, 0)] } })
  })

  it('is not stopped by natural stone, obsidian, or netherrack around the lava', async () => {
    const { world, skill } = setup()
    world.setBlock(at(6, SURFACE, 0), 'lava')
    world.setBlock(at(6, SURFACE, 1), 'obsidian')
    world.setBlock(at(6, SURFACE, -1), 'netherrack')
    world.setBlock(at(7, SURFACE, 0), 'stone')
    const { context } = skillContext()

    const result = await skill.run(lava, context)

    expect(result).toMatchObject({ ok: true, value: { filled: 1 } })
  })

  it('refuses lava in a protected area, even when the block is named', async () => {
    const { world, skill } = setup()
    pool(world)
    world.protectedBoxes.push({ label: 'Nether portal room', contains: () => true })
    const { context } = skillContext()

    const named = await skill.run({ ...lava, at: at(6, SURFACE, 0) }, context)
    const nearest = await skill.run(lava, context)

    expect(named).toMatchObject({ ok: false, error: { reason: 'protected_area' } })
    expect(nearest).toMatchObject({ ok: false, error: { reason: 'protected_area' } })
    expect(world.taken).toHaveLength(0)
  })

  it('stops after a take when lava has flowed next to the bot, keeping the bucket already filled', async () => {
    const { world, skill } = setup()
    world.give('bucket', 1)
    pool(world)
    const { context } = skillContext()
    world.afterTake = () => {
      world.setBlock(at(Math.floor(world.bot.x) + 1, SURFACE + 1, Math.floor(world.bot.z)), 'lava')
    }

    const result = await skill.run({ ...lava, count: 2 }, context)

    expect(result).toMatchObject({ ok: true, value: { filled: 1, requested: 2 } })
    if (result.ok) expect(result.value.stoppedBecause).toContain('lava flowed')
    expect(world.taken).toHaveLength(1)
  })

  it('never uses or drops a water bucket that is carried', async () => {
    const { world, skill } = setup()
    world.give('water_bucket', 1)
    pool(world)
    const { context } = skillContext()

    await skill.run(lava, context)

    expect(world.carried.get('water_bucket')).toBe(1)
  })

  it('does not say a lava pool refills', async () => {
    const { world, skill } = setup()
    world.pool('lava', at(6, SURFACE, 0), at(7, SURFACE, 1))
    const { context } = skillContext()

    const result = await skill.run(lava, context)

    expect(result).toMatchObject({ ok: true, value: { poolRefills: undefined } })
    if (result.ok) expect(result.value.message).not.toContain('pool')
  })
})
