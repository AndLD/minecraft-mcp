import { beforeEach, describe, expect, it } from '@jest/globals'
import type { DigFailure, Digger, DigAssessment } from '../../../../src/core/digger.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { err, ok, type Result } from '../../../../src/core/result.js'
import type { PlaceSignInput } from '../../../../src/skills/signs/place-sign-skill.js'
import { PlaceSignSkill } from '../../../../src/skills/signs/place-sign-skill.js'
import { SignRegistry } from '../../../../src/state/sign-registry.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeVitals, buildVitals } from '../../../fakes/fake-ports.js'
import {
  AutoScheduler,
  FakeAreaGuard,
  InstantNavigator,
  skillContext,
} from '../../../fakes/gathering-fakes.js'
import {
  FLOOR,
  FakeSignAccess,
  FakeSignSupplier,
  GROUND,
  SignPlacer,
  SignWorld,
} from '../../../fakes/sign-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const at = (x: number, y: number, z: number) => ({ x, y, z })
const LINES = ['Iron', '', '', ''] as const

/** Breaks a block of the sign world (what `replace_block` uses), and can be made to fail. */
class WorldDigger implements Digger {
  readonly dug: Position[] = []
  failure: DigFailure | undefined
  constructor(private readonly world: SignWorld) {}
  assess(position: Position): DigAssessment | undefined {
    const name = this.world.blockAt(position) ?? 'air'
    return { blockName: name, diggable: true, requiredTools: [], canHarvest: true, tool: undefined }
  }
  dig(position: Position): Promise<Result<void, DigFailure>> {
    this.dug.push(position)
    if (this.failure !== undefined) return Promise.resolve(err(this.failure))
    this.world.set(position.x, position.y, position.z, 'air')
    return Promise.resolve(ok(undefined))
  }
}

async function setup(options: { digger?: boolean } = {}) {
  const clock = new FakeClock(0)
  const world = new SignWorld()
  const vitals = new FakeVitals()
  vitals.vitals = buildVitals({ position: at(0, FLOOR, 0) })
  const navigator = new InstantNavigator()
  const placer = new SignPlacer(world)
  const signs = new FakeSignAccess(world)
  const supplies = new FakeSignSupplier()
  const guard = new FakeAreaGuard()
  const registry = new SignRegistry(clock)
  await registry.attach(new InMemoryStateStore())
  const digger = new WorldDigger(world)
  const skill = new PlaceSignSkill({
    ...(options.digger === false ? {} : { digger }),
    vitals,
    blocks: world,
    signs,
    navigator,
    placer,
    guard,
    supplies,
    registry,
    scheduler: new AutoScheduler(clock),
  })
  return { world, vitals, navigator, placer, signs, supplies, guard, registry, skill, digger }
}

const input = (overrides: Partial<PlaceSignInput> = {}): PlaceSignInput => ({
  reference: at(5, FLOOR, 5),
  face: 'south',
  lines: LINES,
  side: 'front',
  wood: undefined,
  facing: undefined,
  towards: undefined,
  replaceBlock: undefined,
  ...overrides,
})

describe('PlaceSignSkill', () => {
  let s: Awaited<ReturnType<typeof setup>>

  beforeEach(async () => {
    s = await setup()
    s.world.set(5, FLOOR, 5, 'stone')
  })

  it('hangs a wall sign on a side face, writes the text, and remembers the sign', async () => {
    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: {
        position: at(5, FLOOR, 6),
        kind: 'wall',
        item: 'oak_sign',
        facing: 'south',
        side: 'front',
      },
    })
    // Sneaking, so that a click on a chest or a door places the sign instead of using the block.
    expect(s.placer.placed).toEqual([
      {
        item: 'oak_sign',
        reference: at(5, FLOOR, 5),
        face: { x: 0, y: 0, z: 1 },
        options: { sneak: true },
      },
    ])
    // A wall sign takes its direction from the wall: the bot stands in front of it, near enough to reach.
    expect(s.navigator.trips).toEqual([{ target: at(5, FLOOR, 7), within: 1 }])
    expect(s.signs.writes).toEqual([
      { position: at(5, FLOOR, 6), side: 'front', lines: LINES, reopen: false },
    ])
    expect(s.registry.at(at(5, FLOOR, 6))).toMatchObject({ lines: LINES, wood: 'oak' })
  })

  it('puts a standing sign on a top face, standing exactly on the side its text should face', async () => {
    const result = await s.skill.run(
      input({ reference: at(10, GROUND, 10), face: 'top', facing: 'east' }),
      skillContext().context,
    )

    expect(result.ok && result.value.kind).toBe('standing')
    expect(s.placer.placed[0]?.face).toEqual({ x: 0, y: 1, z: 0 })
    expect(s.navigator.trips).toEqual([{ target: at(12, FLOOR, 10), within: 0 }])
  })

  it('turns a standing sign towards the player by default, and to the bot without one', async () => {
    s.vitals.vitals = buildVitals({ position: at(0, FLOOR, 10) })
    const reference = at(10, GROUND, 10)
    await s.skill.run(
      input({ reference, face: 'top', towards: at(10, FLOOR, 30) }),
      skillContext().context,
    )
    expect(s.navigator.trips[0]?.target).toEqual(at(10, FLOOR, 12))

    s.navigator.trips.length = 0
    s.world.removeSign(at(10, FLOOR, 10))
    await s.skill.run(input({ reference, face: 'top' }), skillContext().context)
    // The bot is to the west of the sign, so the text faces west.
    expect(s.navigator.trips[0]?.target).toEqual(at(8, FLOOR, 10))
  })

  it('chooses the free side nearest to the bot when no face and no player are given (a sign beside a chest)', async () => {
    s.world.set(5, FLOOR, 5, 'chest')
    s.world.set(5, FLOOR, 4, 'stone')
    s.vitals.vitals = buildVitals({ position: at(-2, FLOOR, 5) })

    const result = await s.skill.run(input({ face: undefined }), skillContext().context)

    expect(result.ok && result.value.position).toEqual(at(4, FLOOR, 5))
    expect(s.placer.placed[0]?.face).toEqual({ x: -1, y: 0, z: 0 })
  })

  it('prefers the side that faces the player when one is known', async () => {
    s.world.set(5, FLOOR, 5, 'chest')
    s.vitals.vitals = buildVitals({ position: at(-2, FLOOR, 5) })

    const result = await s.skill.run(
      input({ face: undefined, towards: at(5, FLOOR, 30) }),
      skillContext().context,
    )

    expect(result.ok && result.value.position).toEqual(at(5, FLOOR, 6))
  })

  it('fails when no side of the block is free', async () => {
    for (const [x, z] of [
      [5, 4],
      [5, 6],
      [4, 5],
      [6, 5],
    ] as const)
      s.world.set(x, FLOOR, z, 'stone')

    const result = await s.skill.run(input({ face: undefined }), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'blocked' } })
    expect(s.placer.placed).toEqual([])
  })

  it('asks the supplier for the wood wanted and uses the item it returns', async () => {
    s.supplies.item = 'spruce_sign'

    const result = await s.skill.run(input({ wood: 'spruce' }), skillContext().context)

    expect(s.supplies.asked).toEqual(['spruce'])
    expect(result.ok && result.value.item).toBe('spruce_sign')
    expect(s.registry.all()[0]?.wood).toBe('spruce')
  })

  describe('refuses', () => {
    const refusal = async (overrides: Partial<PlaceSignInput> = {}) => {
      const result = await s.skill.run(input(overrides), skillContext().context)
      expect(s.placer.placed).toEqual([])
      return result.ok ? undefined : result.error.reason
    }

    it('the underside of a block', async () => {
      expect(await refusal({ face: 'bottom' })).toBe('bad_face')
    })

    it('a block that is not loaded', async () => {
      expect(await refusal({ reference: at(500, FLOOR, 5) })).toBe('not_loaded')
    })

    it('a reference that is not solid, or is a liquid', async () => {
      expect(await refusal({ reference: at(9, FLOOR, 9) })).toBe('not_solid')
      s.world.set(9, FLOOR, 9, 'water')
      expect(await refusal({ reference: at(9, FLOOR, 9) })).toBe('fluid')
    })

    it('a standing sign on top of a chest, which cannot hold one', async () => {
      s.world.set(9, GROUND, 9, 'chest')
      expect(await refusal({ reference: at(9, GROUND, 9), face: 'top' })).toBe('not_solid')
    })

    it('a cell that is taken, or holds water or lava', async () => {
      s.world.set(5, FLOOR, 6, 'oak_planks')
      expect(await refusal()).toBe('blocked')
      s.world.set(5, FLOOR, 6, 'lava')
      expect(await refusal()).toBe('fluid')
    })

    it('a protected area', async () => {
      s.guard.protect('house', () => true)
      expect(await refusal()).toBe('protected_area')
    })

    it('a spot where the bot would have to stand on farmland', async () => {
      for (const z of [7, 8]) s.world.set(5, GROUND, z, 'farmland')
      expect(await refusal()).toBe('no_stand')
    })

    it('a sign when none can be had', async () => {
      s.supplies.item = undefined
      expect(await refusal()).toBe('no_sign_item')
    })

    it('when not connected', async () => {
      s.vitals.vitals = undefined
      expect(await refusal()).toBe('not_connected')
    })
  })

  it('reports a cancel that came while the sign was being made as a cancel, not as missing signs', async () => {
    const run = skillContext()
    s.supplies.item = undefined
    run.controller.abort()

    const result = await s.skill.run(input(), run.context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
  })

  it('reports a walk that failed, and a cancelled one', async () => {
    const noPath = { reason: 'unreachable' as const, message: 'no path' }
    s.navigator.failures = [noPath, noPath, noPath, noPath]
    const unreachable = await s.skill.run(input(), skillContext().context)
    expect(unreachable).toMatchObject({ ok: false, error: { reason: 'unreachable' } })

    s.navigator.failures = [{ reason: 'aborted', message: 'Cancelled.' }]
    const aborted = await s.skill.run(input(), skillContext().context)
    expect(aborted).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(s.placer.placed).toEqual([])
  })

  it('passes on why the game would not place it', async () => {
    s.placer.failure = { reason: 'no_support', message: 'nothing to place against' }

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_support' } })
  })

  it('fails when the sign is not in the world after placing', async () => {
    s.placer.silent = true

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'not_placed' } })
    expect(s.signs.writes).toEqual([])
  })

  it('leaves the sign up and says where it is when the text was not written', async () => {
    s.signs.failure = { reason: 'failed', message: 'the server said no' }

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'text_not_written', detail: { position: at(5, FLOOR, 6) } },
    })
    expect(s.world.blockAt(at(5, FLOOR, 6))).toBe('oak_wall_sign')
  })

  it('does not claim success when the text is not on the sign afterwards', async () => {
    s.signs.ignoreText = true

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'text_not_confirmed' } })
  })

  it('can write the back of the sign', async () => {
    await s.skill.run(input({ side: 'back' }), skillContext().context)

    expect(s.signs.writes[0]?.side).toBe('back')
  })
  describe('a sign on top of a fence', () => {
    const fence = at(10, FLOOR, 10)
    const cell = at(10, FLOOR + 1, 10)
    const onFence = (overrides: Partial<PlaceSignInput> = {}) =>
      input({ reference: fence, face: 'top', ...overrides })
    beforeEach(() => {
      s.world.set(10, FLOOR, 10, 'oak_fence')
    })

    it('tries the next spot when the walk to the first one fails, and names why in the end if none works', async () => {
      const gate = {
        reason: 'unreachable' as const,
        message: 'The oak_fence_gate at 69, 87, 48 would not open',
      }
      s.navigator.failures = [gate]

      const result = await s.skill.run(onFence({ facing: 'north' }), skillContext().context)

      expect(result).toMatchObject({ ok: true, value: { position: cell, kind: 'standing' } })
      expect(s.navigator.trips).toHaveLength(2)
      expect(s.navigator.trips[1]?.target).not.toEqual(s.navigator.trips[0]?.target)
    })

    it('gives the direction of the spot it finally stood on as the way the text faces', async () => {
      s.navigator.failures = [{ reason: 'unreachable', message: 'no route' }]

      const result = await s.skill.run(onFence({ facing: 'north' }), skillContext().context)

      expect(result.ok).toBe(true)
      // The first spot was north of the fence (z 8, facing north); the next is a spot on another side.
      const second = s.navigator.trips[1]?.target
      expect(second !== undefined && (second.x !== 10 || second.z !== 8)).toBe(true)
    })

    it('fails with every spot it tried and why, after four', async () => {
      const failure = { reason: 'unreachable' as const, message: 'the gate would not open' }
      s.navigator.failures = [failure, failure, failure, failure, failure]

      const result = await s.skill.run(onFence(), skillContext().context)

      expect(s.navigator.trips).toHaveLength(4)
      expect(result).toMatchObject({
        ok: false,
        error: {
          reason: 'unreachable',
          message: expect.stringContaining('the gate would not open'),
        },
      })
      if (!result.ok) {
        const detail = result.error.detail as { tried: unknown[] }
        expect(detail.tried).toHaveLength(4)
      }
      expect(s.placer.placed).toEqual([])
    })

    it('stops at once when cancelled during the walk', async () => {
      s.navigator.failures = [{ reason: 'aborted', message: 'stopped' }]

      const result = await s.skill.run(onFence(), skillContext().context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
      expect(s.navigator.trips).toHaveLength(1)
    })

    describe('with a torch on top of it', () => {
      beforeEach(() => {
        s.world.set(10, FLOOR + 1, 10, 'torch')
        s.world.set(12, FLOOR, 10, 'oak_fence')
        s.world.names.push('oak_fence', 'torch')
        s.world.origin = at(10, FLOOR, 8) // where the bot is: the scan for the next post starts here
      })

      it('says which free places there are instead, and how to swap the torch', async () => {
        const result = await s.skill.run(onFence(), skillContext().context)

        expect(result).toMatchObject({
          ok: false,
          error: {
            reason: 'blocked',
            message: expect.stringContaining('taken by torch'),
          },
        })
        if (result.ok) return
        expect(result.error.message).toContain(
          'the top of the next oak_fence (at (12, 64, 10), face top)',
        )
        expect(result.error.message).toContain('side of the same oak_fence')
        expect(result.error.message).toContain('replace_block: true')
        const detail = result.error.detail as {
          alternatives: { reference: Position; face: string }[]
        }
        expect(detail.alternatives[0]).toEqual({ reference: at(12, FLOOR, 10), face: 'top' })
        expect(detail.alternatives.length).toBeLessThanOrEqual(3)
        expect(s.digger.dug).toEqual([])
      })

      it('swaps the torch for the sign when asked to', async () => {
        const result = await s.skill.run(onFence({ replaceBlock: true }), skillContext().context)

        expect(result).toMatchObject({ ok: true, value: { position: cell, kind: 'standing' } })
        expect(s.digger.dug).toEqual([cell])
        expect(s.world.blockAt(cell)).toBe('oak_sign')
        // The bot walked to its spot before breaking anything.
        expect(s.navigator.trips.length).toBeGreaterThan(0)
      })

      it('says so when the block cannot be broken, and puts no sign up', async () => {
        s.digger.failure = { reason: 'not_diggable', message: 'too hard' }

        const result = await s.skill.run(onFence({ replaceBlock: true }), skillContext().context)

        expect(result).toMatchObject({ ok: false, error: { reason: 'replace_failed' } })
        expect(s.placer.placed).toEqual([])
      })

      it('stops when cancelled while breaking it', async () => {
        s.digger.failure = { reason: 'aborted', message: 'stopped' }

        const result = await s.skill.run(onFence({ replaceBlock: true }), skillContext().context)

        expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
      })

      it('cannot swap without a digger wired', async () => {
        const bare = await setup({ digger: false })
        bare.world.set(10, FLOOR, 10, 'oak_fence')
        bare.world.set(10, FLOOR + 1, 10, 'torch')

        const result = await bare.skill.run(onFence({ replaceBlock: true }), skillContext().context)

        expect(result).toMatchObject({ ok: false, error: { reason: 'replace_unavailable' } })
      })
    })

    it.each(['chest', 'oak_door', 'white_bed', 'oak_sign'])(
      'never offers, and never does, a swap for a %s',
      async (name) => {
        s.world.set(10, FLOOR + 1, 10, name)

        const refused = await s.skill.run(onFence({ replaceBlock: true }), skillContext().context)

        expect(refused).toMatchObject({ ok: false, error: { reason: 'blocked' } })
        if (!refused.ok) expect(refused.error.message).not.toContain('replace_block: true')
        expect(s.digger.dug).toEqual([])
      },
    )
  })
})
