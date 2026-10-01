import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { HazardRule } from '../../../../src/skills/construction/hazard-rule.js'
import { StandingSpotChooser } from '../../../../src/skills/construction/standing-spot.js'
import {
  BreakBlockSkill,
  type BreakBlockInput,
} from '../../../../src/skills/breaking/break-block-skill.js'
import type { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import { ConstructionWorld } from '../../../fakes/construction-fakes.js'
import { skillContext } from '../../../fakes/gathering-fakes.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })
const FLOOR = 64

const request = (target: Position, extra: Partial<BreakBlockInput> = {}): BreakBlockInput => ({
  at: target,
  collect: true,
  allowContainers: false,
  overrideProtection: false,
  ...extra,
})

function setup() {
  const world = new ConstructionWorld()
  const collected: Position[] = []
  const drops = {
    collectNear: (origin: Position) => {
      collected.push(origin)
      return Promise.resolve()
    },
  } as unknown as DropCollector
  const skill = new BreakBlockSkill({
    vitals: world,
    blocks: world,
    digger: world,
    navigator: world,
    inventory: world,
    guard: world,
    hazards: new HazardRule(world),
    spots: new StandingSpotChooser(world),
    drops,
  })
  return { world, skill, collected }
}

describe('BreakBlockSkill', () => {
  it('breaks exactly the named block, walking into reach first, and picks up the drop', async () => {
    const { world, skill, collected } = setup()
    world.setBlock(at(9, FLOOR, 0), 'oak_stairs')
    world.setBlock(at(10, FLOOR, 0), 'oak_stairs')
    const { context } = skillContext()

    const result = await skill.run(request(at(9, FLOOR, 0)), context)

    expect(result).toMatchObject({
      ok: true,
      value: {
        broken: true,
        block: 'oak_stairs',
        at: at(9, FLOOR, 0),
        gained: [{ name: 'oak_stairs', count: 1 }],
        overrodeProtection: undefined,
      },
    })
    expect(world.trips).toHaveLength(1)
    expect(world.log.filter((line) => line.startsWith('dig'))).toEqual(['dig 9,64,0'])
    expect(world.nameAt(at(9, FLOOR, 0))).toBe('air')
    expect(world.nameAt(at(10, FLOOR, 0))).toBe('oak_stairs')
    expect(collected).toEqual([at(9, FLOOR, 0)])
  })

  it('does not walk when the block is already within reach', async () => {
    const { world, skill } = setup()
    world.setBlock(at(2, FLOOR, 0), 'oak_planks')
    const { context } = skillContext()

    const result = await skill.run(request(at(2, FLOOR, 0)), context)

    expect(result).toMatchObject({ ok: true, value: { broken: true } })
    expect(world.trips).toHaveLength(0)
  })

  it('rounds coordinates down to the block they lie in', async () => {
    const { world, skill } = setup()
    world.setBlock(at(2, FLOOR, 0), 'oak_planks')
    const { context } = skillContext()

    const result = await skill.run(request(at(2.7, FLOOR + 0.5, 0.2)), context)

    expect(result).toMatchObject({ ok: true, value: { at: at(2, FLOOR, 0) } })
  })

  it('leaves the drop lying when collect is off', async () => {
    const { world, skill, collected } = setup()
    world.setBlock(at(2, FLOOR, 0), 'oak_planks')
    const { context } = skillContext()

    await skill.run(request(at(2, FLOOR, 0), { collect: false }), context)

    expect(collected).toEqual([])
  })

  it('never stands on the block it breaks', async () => {
    const { world, skill } = setup()
    const { context } = skillContext()
    const under = at(0, FLOOR - 1, 0) // the floor under the bot at (0.5, 64, 0.5)

    const result = await skill.run(request(under), context)

    expect(result).toMatchObject({ ok: true, value: { broken: true, block: 'dirt' } })
    expect(world.trips).toHaveLength(1)
    expect(Math.floor(world.bot.x) === 0 && Math.floor(world.bot.z) === 0).toBe(false)
  })

  it('does nothing when the cell is already empty', async () => {
    const { world, skill } = setup()
    const { context } = skillContext()

    const result = await skill.run(request(at(3, FLOOR, 3)), context)

    expect(result).toMatchObject({ ok: true, value: { broken: false, block: 'air' } })
    if (result.ok) expect(result.value.message).toContain('already air')
    expect(world.log).toEqual([])
    expect(world.trips).toHaveLength(0)
  })

  it('fails not_loaded for a block that is not loaded', async () => {
    const { world, skill } = setup()
    world.unloaded.add('3,64,3')
    const { context } = skillContext()

    const result = await skill.run(request(at(3, FLOOR, 3)), context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'not_loaded' } })
  })

  it('fails when not connected', async () => {
    const { world, skill } = setup()
    world.read = () => undefined
    const { context } = skillContext()

    const result = await skill.run(request(at(3, FLOOR, 3)), context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
  })

  describe('refusals', () => {
    it.each([
      ['bedrock', 'bedrock', 'unbreakable'],
      ['water', 'water', 'unbreakable'],
      ['lava', 'lava', 'unbreakable'],
    ])('refuses %s as %s', async (name, _label, reason) => {
      const { world, skill } = setup()
      world.setBlock(at(3, FLOOR, 0), name)
      const { context } = skillContext()

      const result = await skill.run(request(at(3, FLOOR, 0)), context)

      expect(result).toMatchObject({ ok: false, error: { reason } })
      expect(world.log).toEqual([])
    })

    it('names the tool to craft when the block needs one that is not carried', async () => {
      const { world, skill } = setup()
      world.setBlock(at(3, FLOOR, 0), 'stone')
      world.needsTool.set('stone', 'wooden_pickaxe')
      world.hasTool = false
      const { context } = skillContext()

      const result = await skill.run(request(at(3, FLOOR, 0)), context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'no_suitable_tool' } })
      if (!result.ok) expect(result.error.message).toContain('wooden_pickaxe')
    })

    it.each(['chest', 'barrel', 'trapped_chest', 'furnace', 'hopper'])(
      'refuses a %s unless containers are allowed',
      async (name) => {
        const { world, skill } = setup()
        world.setBlock(at(3, FLOOR, 0), name)
        const { context } = skillContext()

        const refused = await skill.run(request(at(3, FLOOR, 0)), context)
        expect(refused).toMatchObject({ ok: false, error: { reason: 'holds_items' } })
        expect(world.nameAt(at(3, FLOOR, 0))).toBe(name)

        const allowed = await skill.run(
          request(at(3, FLOOR, 0), { allowContainers: true }),
          context,
        )
        expect(allowed).toMatchObject({ ok: true, value: { broken: true, block: name } })
      },
    )

    it.each([
      ['lava beside it', at(4, FLOOR, 0), 'lava', 'hit_lava'],
      ['lava above it', at(3, FLOOR + 1, 0), 'lava', 'hit_lava'],
      ['water behind it', at(3, FLOOR, 1), 'water', 'hit_water'],
      ['gravel above it', at(3, FLOOR + 1, 0), 'gravel', 'falling_blocks'],
      ['sand above it', at(3, FLOOR + 1, 0), 'sand', 'falling_blocks'],
    ])('refuses when there is %s', async (_what, cell, name, reason) => {
      const { world, skill } = setup()
      world.setBlock(at(3, FLOOR, 0), 'stone')
      world.setBlock(cell, name)
      const { context } = skillContext()

      const result = await skill.run(request(at(3, FLOOR, 0)), context)

      expect(result).toMatchObject({ ok: false, error: { reason, detail: { hazardAt: cell } } })
      expect(world.nameAt(at(3, FLOOR, 0))).toBe('stone')
      expect(world.trips).toHaveLength(0)
    })

    it('reports lava before a missing tool, so nobody crafts a pickaxe for nothing', async () => {
      const { world, skill } = setup()
      world.setBlock(at(3, FLOOR, 0), 'stone')
      world.setBlock(at(4, FLOOR, 0), 'lava')
      world.needsTool.set('stone', 'wooden_pickaxe')
      world.hasTool = false
      const { context } = skillContext()

      const result = await skill.run(request(at(3, FLOOR, 0)), context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'hit_lava' } })
    })

    it('refuses a spawner', async () => {
      const { world, skill } = setup()
      world.setBlock(at(3, FLOOR, 0), 'spawner')
      const { context } = skillContext()

      const result = await skill.run(request(at(3, FLOOR, 0)), context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'spawner' } })
    })

    it('checks for lava next to a chest that was named, too', async () => {
      const { world, skill } = setup()
      world.setBlock(at(3, FLOOR, 0), 'chest')
      world.setBlock(at(4, FLOOR, 0), 'lava')
      const { context } = skillContext()

      const result = await skill.run(request(at(3, FLOOR, 0), { allowContainers: true }), context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'hit_lava' } })
    })

    it('breaks a rail or a door the player named (the dig rule that leaves them alone does not apply)', async () => {
      const { world, skill } = setup()
      world.setBlock(at(3, FLOOR, 0), 'rail')
      const { context } = skillContext()

      const result = await skill.run(request(at(3, FLOOR, 0)), context)

      expect(result).toMatchObject({ ok: true, value: { broken: true, block: 'rail' } })
    })
  })

  describe('protected areas', () => {
    const protect = (world: ConstructionWorld) => {
      world.protectedBoxes.push({
        label: 'Home',
        contains: (p) => p.x >= 5 && p.x <= 12 && p.z >= -3 && p.z <= 3,
      })
    }

    it('refuses by default and says how the player can override', async () => {
      const { world, skill } = setup()
      world.setBlock(at(9, FLOOR, 0), 'oak_stairs')
      protect(world)
      const { context } = skillContext()

      const result = await skill.run(request(at(9, FLOOR, 0)), context)

      expect(result).toMatchObject({
        ok: false,
        error: { reason: 'protected_area', detail: { area: 'Home' } },
      })
      if (!result.ok) expect(result.error.message).toContain('override_protection')
      expect(world.nameAt(at(9, FLOOR, 0))).toBe('oak_stairs')
      expect(world.trips).toHaveLength(0)
    })

    it('with the override breaks only that block, says so, and leaves the area protected', async () => {
      const { world, skill } = setup()
      world.setBlock(at(9, FLOOR, 0), 'oak_stairs')
      world.setBlock(at(9, FLOOR, 1), 'oak_stairs')
      protect(world)
      const { context } = skillContext()

      const result = await skill.run(
        request(at(9, FLOOR, 0), { overrideProtection: true }),
        context,
      )

      expect(result).toMatchObject({
        ok: true,
        value: { broken: true, overrodeProtection: 'Home' },
      })
      if (result.ok) expect(result.value.message).toContain('protected area "Home"')
      expect(world.nameAt(at(9, FLOOR, 1))).toBe('oak_stairs')
      expect(world.protectedAt(at(9, FLOOR, 0))?.label).toBe('Home')
      expect(world.protectedAt(at(9, FLOOR, 1))?.label).toBe('Home')
    })

    it('does not use the override where it is not needed', async () => {
      const { world, skill } = setup()
      world.setBlock(at(2, FLOOR, 0), 'oak_planks')
      const { context } = skillContext()

      const result = await skill.run(
        request(at(2, FLOOR, 0), { overrideProtection: true }),
        context,
      )

      expect(result).toMatchObject({ ok: true, value: { overrodeProtection: undefined } })
    })

    it.each([
      [
        'lava behind it',
        (w: ConstructionWorld) => { w.setBlock(at(10, FLOOR, 0), 'lava'); },
        'hit_lava',
      ],
      [
        'water behind it',
        (w: ConstructionWorld) => { w.setBlock(at(9, FLOOR + 1, 0), 'water'); },
        'hit_water',
      ],
      ['bedrock', (w: ConstructionWorld) => { w.setBlock(at(9, FLOOR, 0), 'bedrock'); }, 'unbreakable'],
    ])('still refuses %s even with the override', async (_what, prepare, reason) => {
      const { world, skill } = setup()
      world.setBlock(at(9, FLOOR, 0), 'oak_stairs')
      prepare(world)
      protect(world)
      const { context } = skillContext()

      const result = await skill.run(
        request(at(9, FLOOR, 0), { overrideProtection: true }),
        context,
      )

      expect(result).toMatchObject({ ok: false, error: { reason } })
    })

    it('still asks about a chest inside a protected area with the override', async () => {
      const { world, skill } = setup()
      world.setBlock(at(9, FLOOR, 0), 'chest')
      protect(world)
      const { context } = skillContext()

      const result = await skill.run(
        request(at(9, FLOOR, 0), { overrideProtection: true }),
        context,
      )

      expect(result).toMatchObject({ ok: false, error: { reason: 'holds_items' } })
    })
  })

  describe('failures on the way', () => {
    it('fails unreachable when there is nowhere to stand within reach', async () => {
      const { world, skill } = setup()
      const { context } = skillContext()

      // Deep inside solid ground: no cell with room for a body is near it.
      const result = await skill.run(request(at(10, 40, 10)), context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'unreachable' } })
      expect(world.log).toEqual([])
    })

    it('fails unreachable when the walk fails', async () => {
      const { world, skill } = setup()
      world.setBlock(at(9, FLOOR, 0), 'oak_planks')
      world.navFailures = [{ reason: 'unreachable', message: 'no path' }]
      const { context } = skillContext()

      const result = await skill.run(request(at(9, FLOOR, 0)), context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'unreachable' } })
    })

    it('is cancelled during the walk', async () => {
      const { world, skill } = setup()
      world.setBlock(at(9, FLOOR, 0), 'oak_planks')
      const { context, controller } = skillContext()
      controller.abort()

      const result = await skill.run(request(at(9, FLOOR, 0)), context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
      expect(world.nameAt(at(9, FLOOR, 0))).toBe('oak_planks')
    })

    it('steps closer and tries again when the dig says the block is out of reach', async () => {
      const { world, skill } = setup()
      world.setBlock(at(2, FLOOR, 0), 'oak_planks')
      world.digFailures = [{ reason: 'out_of_reach', message: 'too far' }]
      const { context } = skillContext()

      const result = await skill.run(request(at(2, FLOOR, 0)), context)

      expect(result).toMatchObject({ ok: true, value: { broken: true } })
      expect(world.trips).toHaveLength(1)
    })

    it('reports a dig that fails, and one that is cancelled', async () => {
      const { world, skill } = setup()
      world.setBlock(at(2, FLOOR, 0), 'oak_planks')
      world.digFailures = [
        { reason: 'failed', message: 'the server said no' },
        { reason: 'aborted', message: 'Cancelled.' },
        { reason: 'not_diggable', message: 'cannot be dug' },
      ]
      const { context } = skillContext()

      expect(await skill.run(request(at(2, FLOOR, 0)), context)).toMatchObject({
        ok: false,
        error: { reason: 'failed', message: 'the server said no' },
      })
      expect(await skill.run(request(at(2, FLOOR, 0)), context)).toMatchObject({
        ok: false,
        error: { reason: 'aborted' },
      })
      expect(await skill.run(request(at(2, FLOOR, 0)), context)).toMatchObject({
        ok: false,
        error: { reason: 'unbreakable' },
      })
    })

    it('does not report success when the block is still there after the dig', async () => {
      const { world, skill } = setup()
      world.setBlock(at(2, FLOOR, 0), 'oak_planks')
      const dig = world.dig.bind(world)
      world.dig = async (position, signal) => {
        const done = await dig(position, signal)
        world.setBlock(position, 'oak_planks')
        return done
      }
      const { context } = skillContext()

      const result = await skill.run(request(at(2, FLOOR, 0)), context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'not_broken' } })
    })
  })
})
